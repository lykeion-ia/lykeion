import { afterEach, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  KERNEL_SETUP_CHANNEL,
  type KernelEnvStatus,
  type KernelSetupProgress,
  type LykeionApi,
} from "@lykeion/api";
import { expectRejection } from "@lykeion/api/conformance";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
import { environmentStore } from "../store/environments";
import { readConfig } from "../config";
import { createChannel, type Channel } from "../channel";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createTitleRegistry } from "../title-registry";
import { createPendingCells } from "../kernel-cells";
import { createEnvSetupRegistry, type EnvSetupRegistry } from "../env-setup-registry";
import { createRequestListener } from "../http";
import { handleDaemonRoute } from "../routes/daemon-routes";
import { hashSecret } from "../auth";
import { apiFor, signUpOwner } from "../test-support/server-api";
import { seedLabContent } from "../store/seed";
import { changeRecorder } from "./changes";
import { buildEnvironmentOn, environmentsApi } from "./environments";
import type { Deps } from "./index";
import type { Store } from "../store/store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-environments-api-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // best effort — a stuck close must not strand the rest of cleanup.
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort — nothing here is worth failing an already-passed test.
    }
  }
});

const NOW = 1_800_000_000;

function addOwner(store: Store, id: string): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@lab.example`, id, "x", NOW, nextSeq(store)],
  );
  store.run(`INSERT INTO members (user_id, role, joined_ts, seq) VALUES (?, 'owner', ?, ?)`, [
    id,
    NOW,
    nextSeq(store),
  ]);
}

function depsFor(store: Store, overrides: Partial<Deps> = {}): Deps {
  const actor = { userId: "u_ana", role: "owner" } as const;
  const channel = createChannel(store, 1000);
  return {
    store,
    actor,
    now: () => NOW,
    config: readConfig({}),
    channel,
    runs: createRunRelay(),
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(),
    titles: createTitleRegistry(),
    pendingCells: createPendingCells(), envSetups: createEnvSetupRegistry(),
    changes: changeRecorder({ store, actorId: actor.userId, now: () => NOW, channel }),
    ...overrides,
  };
}

/** A machine of `ownerId`'s, last heard from at `lastSeenTs` — enough of a
 *  `runtimes` row for `authorizedOwnRuntime` to resolve and for `healthFor`
 *  to judge, which is all `kernelEnvSetup` reads. */
function addRuntime(store: Store, id: string, ownerId: string, lastSeenTs: number): void {
  store.run(
    `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
     VALUES (?, ?, ?, 'macos-aarch64', '0.1.0', '[]', ?, ?, ?)`,
    [id, ownerId, `${id}-machine`, NOW, lastSeenTs, nextSeq(store)],
  );
}

/** The registry the server itself wires in, waiting milliseconds instead of
 *  forty. `await`'s `timeoutMs` is already part of its own signature, so the
 *  timeout branch is reachable from a test without production code growing
 *  a parameter it would otherwise not have. */
function waitingOnly(timeoutMs: number): EnvSetupRegistry {
  const real = createEnvSetupRegistry();
  return {
    await: (machineId, requestId, name, options) =>
      real.await(machineId, requestId, name, { ...options, timeoutMs }),
    settle: (machineId, requestId, result) => real.settle(machineId, requestId, result),
    askedToResolve: (machineId, requestId, name) =>
      real.askedToResolve(machineId, requestId, name),
    resolvedFrom: (machineId, requestId, name) => real.resolvedFrom(machineId, requestId, name),
  };
}

it("declares with the actor who asked, when, and this phase's one manager", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  const declared = await envs.kernelEnvCreate({
    name: "crispr",
    language: "python",
    packages: ["scanpy", "anndata"],
  });

  expect(declared.createdBy).toBe("u_ana");
  expect(declared.createdTs).toBe(NOW);
  // Not asked for on the input — this phase has exactly one manager (D1) —
  // but a declaration always carries one.
  expect(declared.manager).toBe("uv");
  expect(declared.lockRevision).toBe(0);
});

it("refuses anything but Python with the reason D1 gives", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await expectRejection(
    envs.kernelEnvCreate({ name: "r-stats", language: "r", packages: [] }),
    "unsupported",
    /^Lykeion manages Python environments only for now — an R kernel uses the machine's own R\.$/,
  );
});

it("refuses a name no machine could ever build, in front of whoever typed it", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  // A declaration's name becomes a directory on every machine that builds
  // it — `<workDir>/envs/<name>` — and the daemon's own `envRoot` refuses
  // anything that is not one path segment. Accepted here, this would be a
  // declaration that fails on a colleague's machine hours later with nobody
  // in front of it to read the failure.
  for (const name of ["../etc", "my env", "", "crispr/v2"]) {
    await expectRejection(
      envs.kernelEnvCreate({ name, language: "python", packages: ["scanpy"] }),
      "invalid",
      // What a researcher can act on, not the rule's regex.
      /letters, numbers, dashes and underscores/,
    );
  }
  // Refused, not merely reported: nothing was declared.
  expect(await envs.kernelEnvList()).toEqual([]);

  // And the shapes a researcher actually types still go through.
  const declared = await envs.kernelEnvCreate({
    name: "crispr_v2-final",
    language: "python",
    packages: ["scanpy"],
  });
  expect(declared.name).toBe("crispr_v2-final");
});

it("refuses the same names on the agent's wire as on the researcher's own", async () => {
  // Two surfaces, one rule. A researcher types a name into this lab; an
  // agent asks for one through `manage_environments`, which arrives over
  // `/daemon/kernel-env/create`. Two copies of the check would drift, and
  // the drift is a name a researcher can create and no agent can — or, the
  // way that goes wrong, a name an agent can create that every machine then
  // has to turn into a directory it cannot make.
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_1", "u_ana", NOW);
  store.run(
    `INSERT INTO machine_tokens (token_hash, runtime_id, owner_id, created_ts, seq) VALUES (?, ?, ?, ?, ?)`,
    [hashSecret("a-real-token"), "rt_1", "u_ana", NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('se_1', 's_1', 'rt_1', 'claude', 'u_ana', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  const envs = environmentsApi(depsFor(store));

  for (const name of ["../etc", "my env", "crispr/v2"]) {
    await expectRejection(
      envs.kernelEnvCreate({ name, language: "python", packages: ["scanpy"] }),
      "invalid",
      /letters, numbers, dashes and underscores/,
    );
    const overTheWire = handleDaemonRoute({
      store,
      changes: changeRecorder({
        store,
        actorId: null,
        now: () => NOW,
        channel: createChannel(store, 1000),
      }),
      method: "POST",
      path: "/daemon/kernel-env/create",
      body: { sessionId: "se_1", name, packages: ["scanpy"] },
      authorization: "Bearer a-real-token",
      now: NOW,
      envSetups: createEnvSetupRegistry(),
      runs: createRunRelay(),
    });
    expect(overTheWire!.status).toBe(400);
    expect((overTheWire!.json as { error: string }).error).toMatch(
      /letters, numbers, dashes and underscores/,
    );
  }
  expect(await envs.kernelEnvList()).toEqual([]);
});

it("refuses a name this lab already has", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await expectRejection(
    envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["anndata"] }),
    "conflict",
    /crispr/,
  );
});

it("refuses a name that differs from one this lab has only in case, because both are one folder", async () => {
  // Two rows in SQLite (its default collation is case-sensitive) and ONE
  // directory on every machine (seatbelt is the only backend, so every
  // machine is macOS, whose default volume is not). `materializeEnvironment`
  // runs `uv venv --clear` over `<workDir>/envs/<name>`, so the second
  // declaration's first build deletes the first one's — the starter every
  // default Python kernel in the lab runs in, if the pair is `python`.
  // Afterwards `readEnvStatus("python")` reads the other declaration's
  // marker and every `python`-bound kernel silently runs its interpreter.
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "python", language: "python", packages: ["numpy"] });
  await expectRejection(
    envs.kernelEnvCreate({ name: "Python", language: "python", packages: ["torch"] }),
    "conflict",
    // Both spellings, because which one this lab already holds is what the
    // caller needs in order to write its next call.
    /already has an environment named python.*Python would be the same folder/s,
  );
  // Refused, not folded onto the existing one: nothing was written, and the
  // declaration this lab already had is untouched.
  expect((await envs.kernelEnvList()).map((e) => [e.name, e.packages])).toEqual([
    ["python", ["numpy"]],
  ]);
});

it("deleting drops a declaration from the list, hard, all the way down", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");

  expect(await envs.kernelEnvList()).toEqual([]);
  // A hard delete, not a tombstone (fix round 1): the store beneath the API
  // answers `undefined` here, the same as a name that was never declared.
  expect(environmentStore(store).get("crispr")).toBeUndefined();
});

it("refuses to delete an environment this lab never declared, including one already deleted", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await expectRejection(envs.kernelEnvDelete("bogus"), "not-found", /bogus/);

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");
  // A second delete of the same name now takes the identical path an
  // unknown name does — there is no longer a distinct "already gone" case.
  await expectRejection(envs.kernelEnvDelete("crispr"), "not-found", /crispr/);
});

it("refuses to delete the starter — nobody made it, and a lab with none has no way to make one", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  // The real path a fresh lab actually takes, not a hand-built stand-in.
  seedLabContent(store);
  const envs = environmentsApi(depsFor(store));

  await expectRejection(
    envs.kernelEnvDelete("python"),
    "forbidden",
    /Lykeion's own starter environment/,
  );
  // Refused, not merely left undone: the declaration is exactly as it was.
  expect(environmentStore(store).get("python")).toBeDefined();

  // A declaration a researcher DID create is unaffected by this guard.
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");
  expect(environmentStore(store).get("crispr")).toBeUndefined();
});

it("lets a deleted name be declared again, starting fresh with no lock carried over", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");

  // Before the fix, this second create hit the `kernel_envs.name` PRIMARY
  // KEY the deleted row still occupied and threw a raw SQLite error rather
  // than succeeding or raising a `LykeionError`.
  const recreated = await envs.kernelEnvCreate({
    name: "crispr",
    language: "python",
    packages: ["anndata"],
  });
  expect(recreated.packages).toEqual(["anndata"]);
  // The number that matters: a fresh declaration pins nothing yet, and
  // nothing of its predecessor's lockfile survives under it.
  expect(recreated.lockRevision).toBe(0);
});

// ---------------------------------------------------------------------------
// `kernelEnvSetup`'s refusals, each against the branch that raises it and
// each asserting the CODE a client will branch on, not merely that something
// threw. The direct harness rather than the wire server below: these need a
// machine held at a chosen `last_seen_ts`, a registry with a chosen wait, and
// a relay that answers exactly once — none of which a real daemon stub
// obliges. Distinct runtime ids per test, because `inFlightSetups` coalesces
// on `${machineId}:${name}` across the whole module.
// ---------------------------------------------------------------------------

it("refuses setup on an offline machine with conflict, before any command is minted", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  // Silent for an hour: well past `UNSTABLE_WITHIN_SECONDS`.
  addRuntime(store, "rt_offline", "u_ana", NOW - 3600);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  relay.attach("rt_offline", (_seq, command) => {
    taken.push(command);
  });
  // A short wait as well, so that a day this guard stops holding this test
  // says so in one assertion rather than hanging on the machine's silence.
  const envs = environmentsApi(depsFor(store, { runs: relay, envSetups: waitingOnly(20) }));
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });

  await expectRejection(envs.kernelEnvSetup("rt_offline", "crispr"), "conflict", /is offline/);
  // Refused ahead of the relay, not merely reported: nothing was sent.
  expect(taken).toEqual([]);
});

it("refuses with conflict when the declaration names a revision whose lockfile this lab does not hold", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_missing", "u_ana", NOW);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  relay.attach("rt_missing", (_seq, command) => {
    taken.push(command);
  });
  const envs = environmentsApi(depsFor(store, { runs: relay, envSetups: waitingOnly(20) }));
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  // A declaration pointing at a pin this lab cannot produce. The machine
  // must not be told to resolve instead: that is exactly the second,
  // independent resolution D4 exists to prevent, and it would silently
  // become revision 4 as if nothing were wrong.
  store.run(`UPDATE kernel_envs SET lock_revision = 3 WHERE name = 'crispr'`);

  await expectRejection(
    envs.kernelEnvSetup("rt_missing", "crispr"),
    "conflict",
    /revision 3 is missing from this lab's own store/,
  );
  expect(taken).toEqual([]);
});

it("refuses with conflict when the machine takes the command and never answers", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_silent", "u_ana", NOW);
  const relay = createRunRelay();
  // Takes the command and says nothing back, which is what a machine that
  // died mid-build looks like from here.
  const detach = relay.attach("rt_silent", () => {});
  const envs = environmentsApi(depsFor(store, { runs: relay, envSetups: waitingOnly(20) }));
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });

  await expectRejection(
    envs.kernelEnvSetup("rt_silent", "crispr"),
    "conflict",
    /did not finish setting up crispr in time/,
  );
  detach();
});

it("reports a failed build as conflict, never unsupported — a build that failed is one that can be retried", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_failing", "u_ana", NOW);
  const relay = createRunRelay();
  // A real wait, cut short only so a settle that somehow misses fails this
  // test rather than hanging it.
  const envSetups = waitingOnly(2000);
  const detach = relay.attach("rt_failing", (_seq, command) => {
    if (command.type !== "kernel-env-setup") return;
    // Deferred: `deliverNow` runs this synchronously, before the caller has
    // reached `await` and registered anything to settle.
    setTimeout(() => {
      envSetups.settle("rt_failing", command.runId, {
        ok: false,
        error: "uv pip sync failed: no matching distribution for scanpy==1.9.0",
      });
    }, 0);
  });
  const envs = environmentsApi(depsFor(store, { runs: relay, envSetups }));
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });

  // `unsupported` would read to a client as "this lab cannot manage
  // environments at all" and take Setup off the surface for good, over what
  // is a network blip or a package that would not compile today.
  await expectRejection(
    envs.kernelEnvSetup("rt_failing", "crispr"),
    "conflict",
    /no matching distribution for scanpy==1\.9\.0/,
  );
  detach();
});

// ---------------------------------------------------------------------------
// The wire: `kernelEnvSetup`/`kernelEnvReclaim` over a real server, a real
// run relay, and stub daemons standing in for two researchers' own machines.
// Mirrors the harness `api/kernels.test.ts` builds for `kernelExecute` et
// al., for the same reason: these tests need the raw store and relay
// directly, to see what a command actually carried and to settle the
// server's own wait on a reply the way a real daemon's HTTP calls would.
// ---------------------------------------------------------------------------

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function freshWireServer(): Promise<{
  base: string;
  store: Store;
  relay: RunRelay;
  channel: Channel;
  close(): Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-environments-wire-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><head></head><body></body>");

  const store = openStore(join(dir, "workspace.db"));
  migrate(store);
  const channel = createChannel(store, 1000);
  const relay = createRunRelay();
  const openStreams = new Set<() => void>();
  const config = { ...readConfig({}), host: "127.0.0.1", port: 0, dataDir: dir, uiDir };

  const listener = createRequestListener({
    store,
    config,
    secure: false,
    indexHtml: "<!doctype html><head></head><body></body>",
    channel,
    openStreams,
    runs: relay,
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(),
    titles: createTitleRegistry(),
    pendingCells: createPendingCells(),
    envSetups: createEnvSetupRegistry(),
  });
  const server = createHttpServer(listener);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        store,
        relay,
        channel,
        close: () =>
          new Promise<void>((res) => {
            for (const end of openStreams) end();
            server.close(() => {
              store.close();
              res();
            });
          }),
      });
    });
  });
}

function secretPair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Pairs and reports a machine for whichever `LykeionApi` is handed to it —
 *  the owner's own or an invited member's — enough of `/daemon/report`'s
 *  required fields to bring the runtime online, nothing about its CLI
 *  catalogue, which `kernelEnvSetup`'s own checks never read. */
async function pairMachine(
  base: string,
  api: LykeionApi,
  machineName: string,
): Promise<{ machineId: string; token: string }> {
  const { verifier, challenge } = secretPair();
  const { code } = await api.pairMachine({
    name: machineName,
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    challenge,
    redirect: "http://127.0.0.1:7420/paired",
  });
  const exchanged = await fetch(`${base}/daemon/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  // The pairing response still says `runtimeId` on purpose — a daemon already
  // paired is not upgraded in step with the lab it is paired to, so that one
  // key keeps the old name while everything above it says `machineId`.
  const { token, runtimeId: machineId } = (await exchanged.json()) as {
    token: string;
    runtimeId: string;
  };
  await fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] }),
  });
  return { machineId, token };
}

async function redeemInvite(base: string, code: string): Promise<string> {
  const res = await fetch(`${base}/auth/redeem-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      email: "member@lab.example",
      displayName: "Member",
      password: "a good long password",
    }),
  });
  if (!res.ok) throw new Error(`redeem-invite answered ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** What one stub daemon does with every `kernel-env-setup`/
 *  `kernel-env-reclaim` command it receives on `machineId`'s own connection
 *  — a canned, successful resolve-and-materialize, or reclaim, the way a
 *  real daemon's `handleKernelEnvSetup`/`handleKernelEnvReclaim` would,
 *  without simulating a whole daemon process or running real `uv`.
 *  `resolvedLockfile` is what this stub "resolves" to when a command
 *  carries no lockfile of its own to replay; a command that already
 *  carries one is materialized from THAT text and never resolves — which is
 *  the fact under test. Returns every command this stub received, and its
 *  own detach function. */
function attachEnvStubDaemon(
  lab: { base: string; relay: RunRelay },
  machineId: string,
  token: string,
  resolvedLockfile: string,
): { taken: RunCommand[]; detach: () => void } {
  const taken: RunCommand[] = [];
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${lab.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    taken.push(command);
    if (command.type === "kernel-env-setup") {
      void (async () => {
        let lockRevision = command.lockRevision;
        let lockfile = command.lockfile;
        if (lockfile === undefined) {
          // Nothing to replay — resolve, and learn the revision from the
          // lab's own reply, exactly as `postKernelEnvLock` does.
          lockfile = resolvedLockfile;
          // `requestId` names the ask this machine is carrying out. The lab
          // refuses a pin from a machine it did not ask, because a lockfile
          // is the one thing every OTHER machine later replays verbatim.
          const lockRes = await post("/daemon/kernel-env/lock", {
            requestId: command.runId,
            name: command.name,
            lockfile,
          });
          ({ lockRevision } = (await lockRes.json()) as { lockRevision: number });
        }
        const status: KernelEnvStatus = {
          state: "ready",
          name: command.name!,
          language: command.language ?? "python",
          manager: command.manager ?? "uv",
          platform: "macos-aarch64",
          root: `/work/envs/${command.name}`,
          version: "3.12.7",
          packageCount: 1,
          lockRevision,
        };
        await post("/daemon/kernel-env/result", { requestId: command.runId, ok: true, status });
      })().catch(() => {});
    }
  });
  return { taken, detach };
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition to hold");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("resolves once and replays that lockfile on every later machine — Ben never resolves, which is why his numbers match Ana's", async () => {
  const lab = await freshWireServer();
  servers.push(lab);

  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const invite = await ana.createInvite("member");
  const benCookie = await redeemInvite(lab.base, invite.code);
  const ben = apiFor(lab.base, benCookie);

  const { machineId: rtAna, token: tokenAna } = await pairMachine(lab.base, ana, "ana-macbook");
  const { machineId: rtBen, token: tokenBen } = await pairMachine(lab.base, ben, "ben-laptop");

  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });

  const stubAna = attachEnvStubDaemon(lab, rtAna, tokenAna, "scanpy==1.9.0\nanndata==0.10.0\n");
  const stubBen = attachEnvStubDaemon(lab, rtBen, tokenBen, "this-must-never-be-read==0.0.0\n");

  const anaResult = await ana.kernelEnvSetup(rtAna, "crispr");
  expect(anaResult.state).toBe("ready");
  expect(anaResult.lockRevision).toBe(1);

  const envs = environmentStore(lab.store);
  expect(envs.get("crispr")!.lockRevision).toBe(1);
  const storedLockfile = envs.readLock("crispr", 1);
  expect(storedLockfile).toBe("scanpy==1.9.0\nanndata==0.10.0\n");

  const anaSetups = stubAna.taken.filter((c): c is RunCommand & { type: "kernel-env-setup" } =>
    c.type === "kernel-env-setup",
  );
  expect(anaSetups).toHaveLength(1);
  // Nothing to replay yet — Ana's machine is the one that resolves.
  expect(anaSetups[0]!.lockfile).toBeUndefined();
  expect(anaSetups[0]!.packages).toEqual(["scanpy"]);

  const benResult = await ben.kernelEnvSetup(rtBen, "crispr");
  expect(benResult.state).toBe("ready");
  expect(benResult.lockRevision).toBe(1);

  const benSetups = stubBen.taken.filter((c): c is RunCommand & { type: "kernel-env-setup" } =>
    c.type === "kernel-env-setup",
  );
  expect(benSetups).toHaveLength(1);
  // Ben's machine never resolves. This is the whole reason his figures
  // match Ana's rather than whatever PyPI happens to resolve to today.
  expect(benSetups[0]!.lockfile).toBe(storedLockfile);
  expect(benSetups[0]!.lockRevision).toBe(1);
  expect(benSetups[0]!.packages).toBeUndefined();

  // The lab's own revision never moved a second time — only a resolve can
  // move it, and Ben's machine never resolved.
  expect(envs.get("crispr")!.lockRevision).toBe(1);

  stubAna.detach();
  stubBen.detach();
});

/** Every `kernel-env-setup` one stub daemon has been sent, newest last. */
function setupsOf(taken: RunCommand[]): RunCommand[] {
  return taken.filter((command) => command.type === "kernel-env-setup");
}

it("replays a pin that still answers the declaration, and resolves again the moment it does not", async () => {
  // The whole of D4's branch, both halves in one run, because each half on
  // its own passes an implementation that is wrong in the other direction:
  // "always replay" silently drops every package a researcher just approved,
  // and "always resolve" re-pins the lab on every Setup and drifts the
  // moment a maintainer publishes.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "stale", language: "python", packages: ["scanpy"] });
  const stub = attachEnvStubDaemon(lab, machineId, token, "scanpy==1.9.0\n");
  const envs = environmentStore(lab.store);

  // First: nothing pinned, so this machine resolves — and the lab writes
  // down what it asked to be resolved FROM beside the text that came back.
  await ana.kernelEnvSetup(machineId, "stale");
  expect(envs.get("stale")!.lockRevision).toBe(1);
  expect(envs.readLockRequest("stale", 1)).toEqual(["scanpy"]);

  // Second, unchanged: the pin still answers the declaration, so this
  // replays. Without this half a "resolve whenever in doubt" implementation
  // passes everything below.
  await ana.kernelEnvSetup(machineId, "stale");
  expect(setupsOf(stub.taken)).toHaveLength(2);
  expect(setupsOf(stub.taken)[1]!.lockfile).toBe("scanpy==1.9.0\n");
  expect(setupsOf(stub.taken)[1]!.packages).toBeUndefined();
  expect(envs.get("stale")!.lockRevision).toBe(1);

  // Now the declaration grows past its pin, which is exactly what
  // `manage_packages` does to it.
  envs.addPackages("stale", ["anndata"]);

  await ana.kernelEnvSetup(machineId, "stale");
  const third = setupsOf(stub.taken)[2]!;
  // Resolved, not replayed. Replaying here would build an environment
  // holding no `anndata` at all, on every machine in the lab, with nothing
  // anywhere saying so.
  expect(third.lockfile).toBeUndefined();
  expect(third.packages).toEqual(["scanpy", "anndata"]);
  // And the new pin records the new request, so the NEXT setup replays.
  expect(envs.get("stale")!.lockRevision).toBe(2);
  expect(envs.readLockRequest("stale", 2)).toEqual(["scanpy", "anndata"]);

  await ana.kernelEnvSetup(machineId, "stale");
  expect(setupsOf(stub.taken)[3]!.lockRevision).toBe(2);
  expect(setupsOf(stub.taken)[3]!.packages).toBeUndefined();

  stub.detach();
});

it("resolves when the package added sorts after everything already pinned", async () => {
  // `sameRequest`'s length check, driven. Without it the sorted comparison
  // walks only as far as the shorter list, so a pinned request that is a
  // sorted PREFIX of the declaration reads as a match — pinned from
  // `["anndata"]`, declaration now `["anndata","scanpy"]` — and the pin is
  // replayed, dropping `scanpy` on every machine in the lab.
  //
  // The names are chosen for their ORDER and nothing else: the D4 test above
  // adds `anndata` to a pin of `["scanpy"]`, which sorts BEFORE it, so its
  // first comparison already differs and it passes with or without the guard.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "prefix", language: "python", packages: ["anndata"] });
  const stub = attachEnvStubDaemon(lab, machineId, token, "anndata==0.10.0\n");
  const envs = environmentStore(lab.store);

  await ana.kernelEnvSetup(machineId, "prefix");
  expect(envs.readLockRequest("prefix", 1)).toEqual(["anndata"]);

  envs.addPackages("prefix", ["scanpy"]);
  await ana.kernelEnvSetup(machineId, "prefix");

  const second = setupsOf(stub.taken)[1]!;
  expect(second.lockfile).toBeUndefined();
  expect(second.packages).toEqual(["anndata", "scanpy"]);
  stub.detach();
});

it("resolves for an add that joined a replay, which resolved nothing at all", async () => {
  // The other direction of the coalescing defect. A researcher clicks Setup on
  // an already-pinned environment, so that build REPLAYS and resolves nothing;
  // an agent's add lands while it runs and joins it. Without the re-check the
  // approved packages are not merely built late, they are never resolved —
  // the build the add joined was a materialize of a lockfile written before
  // they existed.
  //
  // Driven through `buildEnvironmentOn` directly rather than the wire, because
  // what has to be arranged is a second caller arriving mid-build; a stub
  // daemon that answers as fast as loopback allows cannot hold that window
  // open.
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_replayjoin", "u_ana", NOW);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  const detach = relay.attach("rt_replayjoin", (_seq, command) => {
    taken.push(command);
  });
  const envSetups = createEnvSetupRegistry();
  const envs = environmentStore(store);
  envs.declare({
    name: "replayjoin", language: "python", manager: "uv", packages: ["numpy"],
    createdBy: "u_ana", createdTs: NOW,
  });
  envs.writeLock("replayjoin", "numpy==1.0.0\n", NOW, ["numpy"]);
  const machine = { machineId: "rt_replayjoin", name: "ana-macbook" };
  const parts = { store, runs: relay, envSetups };
  const ready = (): KernelEnvStatus => ({
    state: "ready", name: "replayjoin", language: "python", manager: "uv",
    platform: "macos-aarch64", root: "/work/envs/replayjoin", version: "3.12.7",
    packageCount: 1, lockRevision: 1,
  });

  // The Setup click. Its plan is a replay — the pin still answers the
  // declaration exactly.
  const click = buildEnvironmentOn(parts, machine, "replayjoin", ["numpy"]);
  await until(() => taken.length === 1);
  expect(taken[0]!.lockfile).toBe("numpy==1.0.0\n");
  expect(taken[0]!.packages).toBeUndefined();

  // The agent's add, landing mid-build. It appends and joins.
  envs.addPackages("replayjoin", ["scanpy"]);
  const added = buildEnvironmentOn(
    parts, machine, "replayjoin", ["numpy", "scanpy"], "scanpy was added to replayjoin",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(taken).toHaveLength(1);

  envSetups.settle("rt_replayjoin", taken[0]!.runId, { ok: true, status: ready() });
  // The click is satisfied by what it asked for and stops there.
  expect((await click).state).toBe("ready");

  // The add is not, and asks for a real resolve.
  await until(() => taken.length === 2);
  expect(taken[1]!.lockfile).toBeUndefined();
  expect(taken[1]!.packages).toEqual(["numpy", "scanpy"]);
  expect(taken[1]!.reason).toBe("scanpy was added to replayjoin");
  envSetups.settle("rt_replayjoin", taken[1]!.runId, { ok: true, status: ready() });
  expect((await added).state).toBe("ready");
  detach();
});

it("gives up in words rather than reporting a build that is not coming", async () => {
  // The bound on the re-check loop. A caller whose packages keep missing every
  // build — something appending on a timer — must not spin forever, and must
  // not be told a build carrying them is on its way. Driven by asking for a
  // package nothing ever adds to the declaration, which is the same shape from
  // the loop's point of view.
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_giveup", "u_ana", NOW);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  const envSetups = createEnvSetupRegistry();
  const detach = relay.attach("rt_giveup", (_seq, command) => {
    taken.push(command);
    // Answered immediately and successfully, so what ends this is the bound
    // and nothing else.
    setTimeout(() => {
      envSetups.settle("rt_giveup", command.runId, {
        ok: true,
        status: {
          state: "ready", name: "giveup", language: "python", manager: "uv",
          platform: "macos-aarch64", root: "/work/envs/giveup", version: "3.12.7",
          packageCount: 0, lockRevision: 0,
        },
      });
    }, 0);
  });
  environmentStore(store).declare({
    name: "giveup", language: "python", manager: "uv", packages: ["numpy"],
    createdBy: "u_ana", createdTs: NOW,
  });

  await expectRejection(
    buildEnvironmentOn(
      { store, runs: relay, envSetups },
      { machineId: "rt_giveup", name: "ana-macbook" },
      "giveup",
      ["numpy", "never-declared"],
    ),
    "conflict",
    /kept changing while ana-macbook was building it/,
  );
  // Bounded, and the bound is what stopped it — not one attempt, not endless.
  expect(taken).toHaveLength(4);
  detach();
});

it("does not re-pin the lab because a package list came back in a different order", async () => {
  // `["a","b"]` and `["b","a"]` are one request. A comparison that called
  // them different would resolve — and so re-pin every machine in the lab —
  // over nothing anybody asked for.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({
    name: "reordered", language: "python", packages: ["scanpy", "anndata"],
  });
  const stub = attachEnvStubDaemon(lab, machineId, token, "scanpy==1.9.0\n");
  const envs = environmentStore(lab.store);

  await ana.kernelEnvSetup(machineId, "reordered");
  expect(envs.get("reordered")!.lockRevision).toBe(1);

  // The same two names, the other way round.
  lab.store.run(`UPDATE kernel_envs SET packages = ? WHERE name = 'reordered'`, [
    JSON.stringify(["anndata", "scanpy"]),
  ]);

  await ana.kernelEnvSetup(machineId, "reordered");

  expect(setupsOf(stub.taken)[1]!.lockfile).toBe("scanpy==1.9.0\n");
  expect(envs.get("reordered")!.lockRevision).toBe(1);
  stub.detach();
});

it("resolves against a pin this lab cannot name the request for, rather than replaying on faith", async () => {
  // A row written before the column that records what a resolve was asked
  // for existed. It is not "resolved from nothing" — it is a request this
  // lab cannot name, and the caller widens: resolving where a replay would
  // have done costs one re-pin, while replaying where a resolve was needed
  // drops packages a researcher approved, on every machine, silently.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "unnamed", language: "python", packages: ["scanpy"] });
  // Pinned the way a database that predates migration 28 holds one: a real
  // lockfile at a real revision, and no record of the request behind it.
  lab.store.run(
    `INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts) VALUES (?, 1, ?, ?)`,
    ["unnamed", "older==0.1.0\n", NOW],
  );
  lab.store.run(`UPDATE kernel_envs SET lock_revision = 1 WHERE name = 'unnamed'`);
  const stub = attachEnvStubDaemon(lab, machineId, token, "scanpy==1.9.0\n");

  await ana.kernelEnvSetup(machineId, "unnamed");

  const setup = setupsOf(stub.taken)[0]!;
  expect(setup.lockfile).toBeUndefined();
  expect(setup.packages).toEqual(["scanpy"]);
  // And the re-pin the widening cost, which the next setup will replay.
  expect(environmentStore(lab.store).readLockRequest("unnamed", 2)).toEqual(["scanpy"]);
  stub.detach();
});

it("refuses a machine that is not the caller's own", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const invite = await ana.createInvite("member");
  const benCookie = await redeemInvite(lab.base, invite.code);
  const ben = apiFor(lab.base, benCookie);

  const { machineId: rtAna } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });

  await expectRejection(ben.kernelEnvSetup(rtAna, "crispr"), "forbidden", /paired/);
});

it("refuses a name this lab has never declared", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId } = await pairMachine(lab.base, ana, "ana-macbook");

  await expectRejection(ana.kernelEnvSetup(machineId, "nope"), "not-found", /nope/);
});

it("refuses setup on a machine this lab has never paired", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await expectRejection(ana.kernelEnvSetup("rt_never-paired", "crispr"), "not-found", /rt_never-paired/);
});

it("collapses two researchers asking the same machine to build the same environment into one command", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");

  let replies = 0;
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    if (command.type !== "kernel-env-setup") return;
    replies += 1;
    // Held open past both requests actually landing on this server, so the
    // race this test is about — two callers arriving before either settles
    // — is not left to however fast a loopback round trip happens to be.
    void new Promise((resolve) => setTimeout(resolve, 200)).then(() =>
      fetch(`${lab.base}/daemon/kernel-env/result`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          requestId: command.runId,
          ok: true,
          status: {
            state: "ready", name: "crispr", language: "python", manager: "uv",
            platform: "macos-aarch64", root: "/work/envs/crispr", version: "3.12.7",
            packageCount: 0, lockRevision: 0,
          },
        }),
      }),
    ).catch(() => {});
  });

  // Two callers racing in, before either has settled.
  const [first, second] = await Promise.all([
    ana.kernelEnvSetup(machineId, "crispr"),
    ana.kernelEnvSetup(machineId, "crispr"),
  ]);
  expect(replies).toBe(1);
  expect(first).toEqual(second);
  detach();
});

it("delivers a real kernel-env-reclaim command naming the environment", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  const { machineId } = await pairMachine(lab.base, ana, "ana-macbook");

  const taken: RunCommand[] = [];
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    taken.push(command);
  });

  await ana.kernelEnvReclaim(machineId, "crispr");
  await until(() => taken.some((c) => c.type === "kernel-env-reclaim"));
  const reclaim = taken.find((c) => c.type === "kernel-env-reclaim")!;
  expect(reclaim.name).toBe("crispr");
  detach();
});

it("reclaims a machine's own copy of the starter even though the starter itself cannot be deleted", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  // The real path a fresh lab actually takes, not a hand-built stand-in.
  seedLabContent(lab.store);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId } = await pairMachine(lab.base, ana, "ana-macbook");

  const taken: RunCommand[] = [];
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    taken.push(command);
  });

  // The guard on `kernelEnvDelete` must not reach this at all: freeing a
  // machine's own copy leaves the declaration standing.
  await ana.kernelEnvReclaim(machineId, "python");
  await until(() => taken.some((c) => c.type === "kernel-env-reclaim"));
  const reclaim = taken.find((c) => c.type === "kernel-env-reclaim")!;
  expect(reclaim.name).toBe("python");
  expect(environmentStore(lab.store).get("python")).toBeDefined();
  detach();
});

it("publishes a machine's setup progress lines on KERNEL_SETUP_CHANNEL", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");

  const seen: KernelSetupProgress[] = [];
  lab.channel.subscribe(undefined, (s) => {
    if (s.type === "change" && s.message.kind === KERNEL_SETUP_CHANNEL)
      seen.push(s.message.payload as KernelSetupProgress);
  });

  const res = await fetch(`${lab.base}/daemon/kernel-env/progress`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: "envsetup_1",
      name: "crispr",
      line: "Resolved 12 packages in 340ms",
    }),
  });

  expect(res.status).toBe(200);
  // `machineId` in the published payload is the paired machine's own,
  // read off the bearer token — the one fact a machine cannot misreport
  // about itself — never trusted from the request body, which carries no
  // machineId at all.
  expect(seen).toEqual([{ machineId, name: "crispr", line: "Resolved 12 packages in 340ms" }]);
});

it("refuses a progress line with no name", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { token } = await pairMachine(lab.base, ana, "ana-macbook");

  const seen: unknown[] = [];
  lab.channel.subscribe(undefined, (s) => {
    if (s.type === "change" && s.message.kind === KERNEL_SETUP_CHANNEL) seen.push(s.message.payload);
  });

  const res = await fetch(`${lab.base}/daemon/kernel-env/progress`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: "envsetup_1", line: "Resolved 12 packages in 340ms" }),
  });

  expect(res.status).toBe(400);
  expect(seen).toEqual([]);
});
