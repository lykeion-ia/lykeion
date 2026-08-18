import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { assertBindable, assertServable, type ServerConfig } from "./config";
import { openStore } from "./store/sqlite";
import { migrate, nextSeq } from "./store/migrations";
import { seedLabContent } from "./store/seed";
import { handleAuthRoute } from "./routes/auth-routes";
import { handleDaemonRoute, resolveMachine } from "./routes/daemon-routes";
import { readCookie, resolveActor, SESSION_COOKIE } from "./auth";
import { createWorkspaceApi } from "./api/index";
import { changeRecorder } from "./api/changes";
import {
  isLykeionError,
  KERNEL_SETUP_CHANNEL,
  type ActiveRunSnapshot,
  type KernelEnvStatus,
  type KernelSetupProgress,
  type RunEventFrame,
} from "@lykeion/api";
import { dispatch, rpcMethods } from "./rpc";
import type { Store } from "./store/store";
import { createChannel, type Channel, type Send } from "./channel";
import { createRunRelay, type RunCommand, type RunRelay } from "./run-relay";
import { createRevertRegistry, type RevertRegistry } from "./run-revert";
import { createKernelListRegistry, type KernelListRegistry, type RawKernelReport } from "./kernel-list-registry";
import { createTitleRegistry, type TitleRegistry } from "./title-registry";
import { createPendingCells, type PendingCells } from "./kernel-cells";
import { createEnvSetupRegistry, type EnvSetupRegistry, type EnvSetupResult } from "./env-setup-registry";
import { failDroppedRuns } from "./run-recovery";
import { readReportedCell, recordCell } from "./store/cells";
import {
  activeRunIdsForMachine,
  addGrant,
  recordRunFrames,
  recordTurnSnapshot,
  RunFrameSequenceGapError,
  runSnapshot,
  machineForTurn,
  machineOwnerForTurn,
  sessionForTurn,
  sessionOwner,
} from "./store/sessions";

const MAX_BODY = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** How the browser learns it is talking to a real lab rather than running
 *  on its own. Injected at serve time, so nothing has to be built twice. */
const MARKER = '<meta name="lykeion-workspace" content="1">';

/**
 * Accumulates a request body up to a cap. Split out from the socket so the
 * one property that matters — that nothing beyond the cap is ever held — can
 * be asserted directly. A caller sending an unbounded body is unauthenticated
 * on the auth routes, so "we buffered it all and then said 413" is not good
 * enough, and a status code cannot tell the two apart.
 */
export function createBodyReader(maxBytes: number) {
  let size = 0;
  let tooLarge = false;
  let chunks: Buffer[] = [];
  return {
    push(chunk: Buffer): void {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    },
    /** Bytes held right now. Never exceeds the cap, whatever was pushed. */
    retained(): number {
      return chunks.reduce((n, c) => n + c.length, 0);
    },
    finish(): string | "too-large" {
      return tooLarge ? "too-large" : Buffer.concat(chunks).toString("utf8");
    },
  };
}

function readBody(req: IncomingMessage): Promise<string | "too-large"> {
  return new Promise((resolve, reject) => {
    const reader = createBodyReader(MAX_BODY);
    // The socket is left to drain rather than destroyed: the sender already
    // committed to writing this whole body without waiting for permission,
    // and tearing the connection down here would race that write and lose
    // the response.
    req.on("data", (chunk: Buffer) => reader.push(chunk));
    req.on("end", () => resolve(reader.finish()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (setCookie) headers["set-cookie"] = setCookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** Whether one entry of a `/daemon/kernel/list` report has the shape a
 *  `kernel.list` answer actually has. Filtered rather than trusted whole,
 *  the same discipline `/daemon/run/events` holds its frames to: this body
 *  crossed a process this store did not write. */
function isRawKernelReport(value: unknown): value is RawKernelReport {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  // Epoch seconds as a whole number, or absent — never a default-valued
  // present one, and never a fraction or a string masquerading as one.
  const isEpochSecondsOrAbsent = (field: unknown): boolean =>
    field === undefined || (typeof field === "number" && Number.isInteger(field));
  return (
    typeof v.id === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.taskId === "string" &&
    typeof v.name === "string" &&
    typeof v.language === "string" &&
    typeof v.state === "string" &&
    typeof v.incarnation === "number" &&
    typeof v.executionCount === "number" &&
    typeof v.queueDepth === "number" &&
    typeof v.environment === "string" &&
    isEpochSecondsOrAbsent(v.startedTs) &&
    isEpochSecondsOrAbsent(v.lastActivityTs) &&
    isEpochSecondsOrAbsent(v.reclaimedTs)
  );
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(
  config: ServerConfig,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<RunningServer> {
  assertBindable(config);
  assertServable(config);
  const store = openStore(join(config.dataDir, "workspace.db"));
  migrate(store);
  seedLabContent(store);
  const secure = Boolean(config.tlsCertPath && config.tlsKeyPath);
  const channel = createChannel(store, config.changeLogRetention);
  // Process-lived the same way `channel` is: the run command queue and
  // event fan-out belong to the running server, not to any one request.
  const runs = createRunRelay();
  const reverts: RevertRegistry = createRevertRegistry();
  const kernelLists: KernelListRegistry = createKernelListRegistry();
  const titles: TitleRegistry = createTitleRegistry();
  const pendingCells: PendingCells = createPendingCells();
  const envSetups: EnvSetupRegistry = createEnvSetupRegistry();
  // Every open `/events` or `/daemon/commands` response, so `close()` can
  // end them itself: a stream nobody tears down keeps its heartbeat alive
  // (harmless — it is `unref`'d) but also keeps `server.close()` waiting on
  // a connection that was never going to close on its own.
  const openStreams = new Set<() => void>();

  const rawIndex = readFileSync(join(config.uiDir, "index.html"), "utf8");
  if (!rawIndex.includes("</head>"))
    throw new Error(
      `the UI at ${config.uiDir} has an index.html with no </head>, so the ` +
        `workspace marker cannot be placed in it. Without the marker the ` +
        `browser cannot tell a real lab from the in-browser demo, and would ` +
        `discard everything a researcher wrote.`,
    );
  const indexHtml = rawIndex.replace("</head>", `${MARKER}</head>`);

  const listener = createRequestListener({
    store, config, secure, indexHtml, now, channel, openStreams, runs, reverts, kernelLists, titles,
    pendingCells, envSetups,
  });
  const server = secure
    ? createHttpsServer(
        { cert: readFileSync(config.tlsCertPath!), key: readFileSync(config.tlsKeyPath!) },
        listener,
      )
    : createHttpServer(listener);

  // Without this the promise never settles on a failed bind and the
  // 'error' event throws out of the process — so the most ordinary startup
  // problem there is, a port already in use, reports as a hang.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Before `server.close()`, not after: an open `/events` connection
        // is a request `server.close()` waits on, so ending it here is what
        // lets that promise's callback ever fire.
        for (const end of openStreams) end();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}

export function createRequestListener(deps: {
  store: Store;
  config: ServerConfig;
  secure: boolean;
  indexHtml: string;
  channel: Channel;
  runs: RunRelay;
  /** Reverts waiting on the machine holding the files to say whether they
   *  are back, so `/daemon/run/reverted` can settle the one it names. */
  reverts: RevertRegistry;
  /** `kernel-list` asks waiting on a machine's own kernel host, so
   *  `/daemon/kernel/list` can settle the one it names. */
  kernelLists: KernelListRegistry;
  /** `name-task` asks waiting on a machine to summarize a Task's opening
   *  message, so `/daemon/task/title` can settle the one it names. */
  titles: TitleRegistry;
  /** The REPL cells this lab has asked a machine to run, so `/daemon/cell`
   *  can recognize the one it is being told about. */
  pendingCells: PendingCells;
  /** `kernel-env-setup` asks waiting on the machine they were sent to, so
   *  `/daemon/kernel-env/result` can settle the one it names. */
  envSetups: EnvSetupRegistry;
  /** Every open `/events` or `/daemon/commands` response's teardown, so the
   *  server that built this listener can end them from `close()`. */
  openStreams: Set<() => void>;
  /** Defaults to the real clock; a test pins this to prove ordering
   *  tiebreaks do the work rather than happening to pass on real time. */
  now?: () => number;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const {
    store, config, secure, indexHtml, channel, openStreams, runs, reverts, kernelLists, titles, pendingCells,
    envSetups,
  } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path.startsWith("/auth/")) {
        // The same content-type check `/rpc/` makes, and for the same
        // reason: `application/json` is not a CORS-simple type, so a form
        // or a `no-cors` fetch from another site cannot reach these routes
        // without a preflight that nothing here answers. Without it, any
        // page open in the researcher's browser can create the owner of a
        // lab that has not been set up yet, or sign them out of one.
        if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json"))
          return sendJson(res, 415, { error: "auth calls are application/json" });
        const raw = req.method === "POST" ? await readBody(req) : "";
        if (raw === "too-large") return sendJson(res, 413, { error: "that request is too large" });
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          return sendJson(res, 400, { error: "that request body is not JSON" });
        }
        // Nobody is signed in on these routes, so the recorder carries no
        // actor of its own; the one route that records names the member it
        // has just made.
        const authChanges = changeRecorder({ store, actorId: null, now, channel });
        try {
          const result = await handleAuthRoute({
            store, changes: authChanges, method: req.method ?? "GET", path, body,
            cookie: req.headers.cookie, secure, now: now(),
          });
          if (result) return sendJson(res, result.status, result.json, result.setCookie);
          return sendJson(res, 404, { error: "no such route" });
        } finally {
          authChanges.flush();
        }
      }

      if (path === "/daemon/commands") {
        // A GET held open, the way `/events` is, rather than a POST: this is
        // a stream a daemon reads from, not a call it makes.
        if (req.method !== "GET") return sendJson(res, 405, { error: "the command stream is read with GET" });
        const machine = resolveMachine(store, req.headers.authorization);
        if (!machine) return sendJson(res, 401, { error: "no such machine" });

        // `Number(null)` is `0`, not `NaN` — an absent parameter must not
        // read as cursor 0, or a daemon's very first connection would replay
        // its whole retained backlog instead of starting fresh.
        const rawCursor = url.searchParams.get("cursor");
        const fromQuery = rawCursor === null ? NaN : Number(rawCursor);
        const cursor = Number.isInteger(fromQuery) ? fromQuery : undefined;

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.flushHeaders();

        let detach: () => void = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const end = () => {
          if (!openStreams.has(end)) return;
          openStreams.delete(end);
          if (heartbeat) clearInterval(heartbeat);
          detach();
          if (!res.writableEnded) res.end();
        };

        // `attach` replays every command this machine has ever been queued —
        // the cursor is honoured here, by skipping what a reconnecting
        // daemon has already told us it handled, not inside the relay.
        const send = (seq: number, command: RunCommand) => {
          if (cursor !== undefined && seq <= cursor) return;
          if (res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify({ seq, command })}\n\n`);
          } catch {
            end();
          }
        };

        openStreams.add(end);
        req.on("close", end);
        detach = runs.attach(machine.machineId, send);
        if (res.writableEnded) return end();

        heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(`: ping\n\n`);
          } catch {
            end();
          }
        }, 25_000);
        heartbeat.unref();
        return;
      }

      if (path.startsWith("/daemon/")) {
        // A paired daemon, not a browser tab, is the only caller here, so
        // there is no CORS story to defend against — but the guard costs
        // nothing to keep, and it refuses a body that was not sent as JSON
        // before a route below can misread it as one.
        if (req.method !== "POST") return sendJson(res, 405, { error: "daemon calls are POST" });
        if (!(req.headers["content-type"] ?? "").includes("application/json"))
          return sendJson(res, 415, { error: "daemon calls are application/json" });
        const raw = await readBody(req);
        if (raw === "too-large") return sendJson(res, 413, { error: "that request is too large" });
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          return sendJson(res, 400, { error: "that request body is not JSON" });
        }

        if (path === "/daemon/run/live") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const rawRunIds = (body as { runIds?: unknown } | null)?.runIds;
          const reportedGeneration = (body as { generation?: unknown } | null)?.generation;
          const reportedCommandCursor = (body as { commandCursor?: unknown } | null)?.commandCursor;
          const runIds = Array.isArray(rawRunIds)
            ? rawRunIds.filter((id): id is string => typeof id === "string")
            : [];
          const acknowledgedCommandSeq =
            reportedGeneration === runs.generation &&
            typeof reportedCommandCursor === "number" &&
            Number.isSafeInteger(reportedCommandCursor) &&
            reportedCommandCursor >= 0
              ? reportedCommandCursor
              : undefined;
          // A cursor has meaning only inside the relay generation that
          // numbered it. Missing/mismatched generation means a new daemon or
          // server process, not "same relay, acknowledged through zero".
          // Reconcile can still protect a start the surviving relay knows was
          // never delivered, but must fail one the previous daemon received
          // and then lost instead of replaying provider work into its restart.
          // Run ids are sequential and guessable — `run_<seq>` off one
          // workspace-wide counter — so a machine's own valid bearer token
          // proves only that some paired machine is calling, not that every
          // id it reports holding is actually its own. Checked against the
          // store — the durable record of which machine a run's session
          // belongs to — before any of it reaches `reconcile`.
          //
          // Two different facts hide behind a run id this store cannot
          // attribute to this machine, and only one of them is an attack.
          // Belonging to a real, different machine is the attack this check
          // exists for, and refuses the whole report over. Resolving to no
          // machine at all — a typo, or a run id this store never minted —
          // is not; refusing the whole report over it would durably wedge
          // an otherwise honest daemon out of every command behind it,
          // since a machine that cannot pass this check never reaches
          // `openCommands` either. Those ids are dropped from what reaches
          // `reconcile` instead: not a member of anyone's `queue.live`,
          // they cannot be reconciled away from it either.
          const reported = runIds.map((runId) => ({ runId, owner: machineForTurn(store, runId) }));
          if (reported.some(({ owner }) => owner !== undefined && owner !== machine.machineId))
            return sendJson(res, 403, { error: "this machine does not own every run it reported" });
          const durableActive = activeRunIdsForMachine(store, machine.machineId);
          const durableActiveSet = new Set(durableActive);
          const retireRunIds = reported
            .filter(
              ({ owner, runId }) =>
                owner === undefined ||
                (owner === machine.machineId && !durableActiveSet.has(runId)),
            )
            .map(({ runId }) => runId);
          const ownedActive = reported
            .filter(({ owner, runId }) => owner !== undefined && durableActiveSet.has(runId))
            .map(({ runId }) => runId);
          const dropped = runs.reconcile(
            machine.machineId,
            ownedActive,
            durableActive,
            acknowledgedCommandSeq,
          );
          failDroppedRuns(store, runs, machine.machineId, dropped, now());
          return sendJson(res, 200, {
            ok: true,
            generation: runs.generation,
            ...(retireRunIds.length === 0 ? {} : { retireRunIds }),
          });
        }
        if (path === "/daemon/run/events") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const runId = (body as { runId?: unknown } | null)?.runId;
          const rawFrames = (body as { frames?: unknown } | null)?.frames;
          if (typeof runId !== "string" || !Array.isArray(rawFrames))
            return sendJson(res, 400, { error: "a runId and a frames array are required" });
          // Run ids are sequential and guessable — `run_<seq>` off one
          // workspace-wide counter — so the bearer token above proves only
          // that *some* paired machine is calling, not that it is the one
          // this run was actually started on. Without this, any machine in
          // the lab could post fabricated frames for a run it never held:
          // a forged `completed` would retire someone else's live run, and
          // forged prose or steps would be attributed to a transcript that
          // was never theirs to write.
          if (machineForTurn(store, runId) !== machine.machineId)
            return sendJson(res, 403, { error: `this machine does not own run ${runId}` });
          const frames = rawFrames.filter(
            (f): f is RunEventFrame =>
              f !== null && typeof f === "object" && typeof (f as { seq?: unknown }).seq === "number",
          );
          // Durable before fanned out, and as one transaction: a subscriber
          // reacting to a published frame by reading `turns`/`turn_steps`
          // straight back out must already find it there, and a batch that
          // fails partway through must not leave part of it durable while
          // none of it was ever published to a browser watching live.
          let accepted: RunEventFrame[];
          try {
            accepted = store.tx(() => recordRunFrames(store, runId, frames, now()));
          } catch (error) {
            if (error instanceof RunFrameSequenceGapError)
              return sendJson(res, 409, { error: error.message });
            throw error;
          }
          runs.publish(runId, accepted);
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/run/snapshot") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const runId = (body as { runId?: unknown } | null)?.runId;
          const taken = (body as { taken?: unknown } | null)?.taken;
          const reason = (body as { reason?: unknown } | null)?.reason;
          if (typeof runId !== "string" || typeof taken !== "boolean")
            return sendJson(res, 400, { error: "a runId and a taken flag are required" });
          if (machineForTurn(store, runId) !== machine.machineId)
            return sendJson(res, 403, { error: "this machine does not own that run" });
          recordTurnSnapshot(store, runId, {
            taken,
            ...(typeof reason === "string" ? { reason } : {}),
          });
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/run/reverted") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const runId = (body as { runId?: unknown } | null)?.runId;
          const ok = (body as { ok?: unknown } | null)?.ok;
          const error = (body as { error?: unknown } | null)?.error;
          if (typeof runId !== "string" || typeof ok !== "boolean")
            return sendJson(res, 400, { error: "a runId and an ok flag are required" });
          if (machineForTurn(store, runId) !== machine.machineId)
            return sendJson(res, 403, { error: "this machine does not own that run" });
          // The record is truncated only from here, once the machine has
          // said the files are back: restore first, truncate second.
          reverts.settle(runId, ok, typeof error === "string" ? error : undefined);
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/run/grant") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const runId = (body as { runId?: unknown } | null)?.runId;
          const grantPath = (body as { path?: unknown } | null)?.path;
          const mode = (body as { mode?: unknown } | null)?.mode;
          if (
            typeof runId !== "string" ||
            typeof grantPath !== "string" ||
            // An empty `grantPath` would read, on the daemon's own `covers()`
            // check, as `path.startsWith("/")` — every absolute path would
            // match, a blanket grant by accident rather than the "global"
            // scope this lab refuses outright by name.
            !(grantPath.startsWith("/") || grantPath.startsWith("~/")) ||
            (mode !== "read" && mode !== "write")
          )
            return sendJson(res, 400, {
              error: `a runId, an absolute path, and a mode of "read" or "write" are required`,
            });
          // The same discipline `/daemon/run/events` holds to: a run id is
          // sequential and guessable, so the bearer token alone proves only
          // that some paired machine is calling, not that it is the one this
          // run actually belongs to. Resolved through the run's own session
          // rather than trusted from the body, so a grant always lands on
          // the Study and machine the run was actually started on. Unlike
          // that route, this one's own refusal names neither case — "no such
          // run" and "not yours" answer with the exact same body — because a
          // grant is a standing authorization record, not a transcript
          // frame, and this is the one route a caller could use to probe
          // which run ids are real by comparing 403 bodies across guesses.
          const session = sessionForTurn(store, runId);
          if (!session || session.machineId !== machine.machineId)
            return sendJson(res, 403, { error: "this machine does not own that run" });
          addGrant(store, {
            studyId: session.studyId,
            machineId: session.machineId,
            path: grantPath,
            mode,
            grantedBy: session.openedBy,
            grantedTs: now(),
          });
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/kernel/list") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const requestId = (body as { requestId?: unknown } | null)?.requestId;
          const rawKernels = (body as { kernels?: unknown } | null)?.kernels;
          if (typeof requestId !== "string" || !Array.isArray(rawKernels))
            return sendJson(res, 400, { error: "a requestId and a kernels array are required" });
          // `requestId` is minted off the same globally-sequential counter
          // session ids are — exactly as guessable — so the bearer token
          // above proves only that some paired machine is calling, not that
          // it is the one this particular ask went to. `settle` itself holds
          // the binding and refuses a mismatch without touching it, so the
          // machine this request actually belongs to can still answer it.
          if (!kernelLists.settle(machine.machineId, requestId, rawKernels.filter(isRawKernelReport)))
            return sendJson(res, 403, { error: "this machine was not asked for that kernel list" });
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/task/title") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const b = body as { requestId?: unknown; title?: unknown } | null;
          const requestId = b?.requestId;
          // `null` is a real answer here — a machine saying it asked and got
          // nowhere — and it is a better one than silence, because it frees
          // the waiting call now rather than at its deadline. Only a missing
          // or wrongly-typed field is a bad request.
          const title = b?.title === undefined ? null : b.title;
          if (typeof requestId !== "string" || (title !== null && typeof title !== "string"))
            return sendJson(res, 400, { error: "a requestId and a title (or null) are required" });
          // Bound before it is trusted: whatever the far side sends travels
          // into a title column and out to every open tab, and a machine
          // sending a megabyte of it must not be able to make that this
          // lab's problem. What survives is still cleaned by `nameTask`.
          if (typeof title === "string" && title.length > 4096)
            return sendJson(res, 400, { error: "that is not a title" });
          // Held to the same binding as `/daemon/kernel/list`, for the same
          // reason: the bearer token proves some paired machine is calling,
          // never that it is the one this ask went to.
          if (!titles.settle(machine.machineId, requestId, title))
            return sendJson(res, 403, { error: "this machine was not asked to name that task" });
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/kernel-env/progress") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const b = body as { requestId?: unknown; name?: unknown; line?: unknown } | null;
          if (typeof b?.requestId !== "string" || typeof b.name !== "string" || typeof b.line !== "string")
            return sendJson(res, 400, { error: "a requestId, a name, and a line are required" });
          // Best-effort and unauthenticated-against-the-registry on purpose:
          // unlike `/daemon/kernel-env/result`, nothing here is waiting on
          // this specific line, so there is no pending entry to check the
          // reporting machine against — only a live channel to publish it
          // to, which every subscriber reads regardless of which machine's
          // build it came from. `machineId` is this machine's own, taken
          // from the token rather than trusted from the body — the one
          // fact a machine cannot misreport about itself — and `name` is
          // what actually lets two builds running at once stay legible on
          // one lab-wide channel.
          const payload: KernelSetupProgress = { machineId: machine.machineId, name: b.name, line: b.line };
          channel.publish({ seq: nextSeq(store), kind: KERNEL_SETUP_CHANNEL, payload });
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/kernel-env/result") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const b = body as { requestId?: unknown; ok?: unknown; status?: unknown; error?: unknown } | null;
          if (typeof b?.requestId !== "string" || typeof b.ok !== "boolean")
            return sendJson(res, 400, { error: "a requestId and an ok flag are required" });
          const result: EnvSetupResult =
            b.ok === true
              ? { ok: true, status: b.status as KernelEnvStatus }
              : { ok: false, error: typeof b.error === "string" ? b.error : "the machine did not say why" };
          // Held to the same binding as `/daemon/kernel/list` and
          // `/daemon/task/title`: the bearer token proves some paired
          // machine is calling, never that it is the one this ask went to.
          if (!envSetups.settle(machine.machineId, b.requestId, result))
            return sendJson(res, 403, { error: "this machine was not asked to set up that environment" });
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/daemon/cell") {
          const machine = resolveMachine(store, req.headers.authorization);
          if (!machine) return sendJson(res, 401, { error: "no such machine" });
          const b = body as Record<string, unknown> | null;
          const cellId = b?.cellId;
          const sessionId = b?.sessionId;
          const taskId = b?.taskId;
          // The cell itself, read to the shape this store's own row has
          // rather than spot-checked: every counter a whole number, every
          // output a message of a kind this lab knows, and nothing accepted
          // because it happened to be a `number` or an array of anything.
          const reported = readReportedCell(b);
          if (typeof cellId !== "string" || typeof sessionId !== "string" || typeof taskId !== "string" || !reported)
            return sendJson(res, 400, { error: "a cell needs its full shape" });
          // A session id is sequential and guessable, the same as a run id —
          // the bearer token above proves only that some paired machine is
          // calling, not that it is the one this session actually belongs
          // to. Without this, any machine in the lab could write a cell into
          // a colleague's Task's notebook, attributed to a REPL session it
          // never held.
          const owner = sessionOwner(store, sessionId);
          if (!owner || owner.machineId !== machine.machineId)
            return sendJson(res, 403, { error: `this machine does not own session ${sessionId}` });
          // `taskId` is what puts this cell on a Task's own notebook, and
          // nothing above ties it to the session it claims to have run in —
          // bound here to the turn that actually opened that session for
          // that Task, not to a Task's own (movable) `study_id`, the same
          // discipline `toRunningKernel` holds a `kernel-list` report to.
          if (!store.get(`SELECT 1 FROM turns WHERE session_id = ? AND task_id = ?`, [sessionId, taskId]))
            return sendJson(res, 403, { error: `session ${sessionId} has no turn recorded for Task ${taskId}` });
          // The id and the attribution are the two things a machine cannot
          // be believed about. This lab minted the id when it asked for the
          // cell, handed it to the browser waiting on it, and remembered the
          // member who asked — so both are taken from that record and
          // neither is read off the report. An id nothing here asked for is
          // refused: it is either a fabricated row for a notebook every
          // member of the lab reads, or a second report of a cell already
          // recorded, which under a PRIMARY KEY would be an insert that
          // throws rather than a route that answers.
          const by = pendingCells.claim(machine.machineId, cellId);
          if (by === undefined)
            return sendJson(res, 403, { error: `this lab did not ask this machine to run cell ${cellId}` });
          // `ts` is the moment being recorded rather than a field of the
          // cell, and is the one thing `recordCell` takes as an argument of
          // its own — so it is taken out here rather than left on the object
          // beside a parameter that says the same thing.
          const { ts, ...ran } = reported;
          recordCell(
            store,
            {
              ...ran,
              id: cellId,
              taskId,
              sessionId,
              // The surface is settled by the route rather than by the
              // report: a cell arriving here is the answer to a
              // `kernel-execute` this lab sent, and an agent's own cells
              // travel their run's event stream instead.
              origin: { surface: "repl", by },
            },
            ts,
          );
          return sendJson(res, 200, { ok: true });
        }

        // Nobody is signed in on this surface — a daemon authenticates with
        // a machine token, never a session cookie — so a change one of
        // these routes records is attributed explicitly, the same way the
        // auth routes attribute a change to the member who was just made.
        const daemonChanges = changeRecorder({ store, actorId: null, now, channel });
        try {
          const result = handleDaemonRoute({
            store, changes: daemonChanges, method: req.method, path, body,
            authorization: req.headers.authorization, now: now(), envSetups, runs,
          });
          if (result) return sendJson(res, result.status, result.json);
          return sendJson(res, 404, { error: "no such route" });
        } finally {
          daemonChanges.flush();
        }
      }

      if (path.startsWith("/rpc/")) {
        if (req.method !== "POST") return sendJson(res, 405, { error: "rpc calls are POST" });
        if (!(req.headers["content-type"] ?? "").includes("application/json"))
          return sendJson(res, 415, { error: "rpc calls are application/json" });

        const actor = resolveActor(store, readCookie(req.headers.cookie, SESSION_COOKIE), now());
        if (!actor) return sendJson(res, 401, { error: "not signed in" });

        const raw = await readBody(req);
        if (raw === "too-large") return sendJson(res, 413, { error: "that request is too large" });
        let args: unknown;
        try {
          args = (JSON.parse(raw) as { args?: unknown }).args;
        } catch {
          return sendJson(res, 400, { error: "that request body is not JSON" });
        }

        // One recorder for the whole call, carried on the deps every family
        // module is handed, so whatever any of them records is in the queue
        // the `flush` below drains.
        const changes = changeRecorder({ store, actorId: actor.userId, now, channel });
        const api = createWorkspaceApi({
          store, actor, now, config, channel, changes, runs, reverts, kernelLists, titles, pendingCells,
          envSetups,
        });
        const method = path.slice("/rpc/".length);
        if (!rpcMethods(api).has(method)) return sendJson(res, 404, { error: `no such method: ${method}` });
        try {
          return sendJson(res, 200, await dispatch(api, method, args as unknown[]));
        } catch (err) {
          // Dispatch raises a typed error for what a caller got wrong. Turning
          // that into a 500 would tell a client its own mistake was the
          // server falling over, and log a stack for every malformed request.
          if (isLykeionError(err))
            return sendJson(res, 200, {
              ok: false,
              error: { code: err.code, message: err.message },
            });
          console.error(`[rpc] ${method} failed`, err);
          return sendJson(res, 500, { error: "the workspace server failed to handle that call" });
        } finally {
          // Every write that got this far already committed or rolled back
          // inside `dispatch` — a write that succeeded before a later one in
          // the same call failed has still happened, and `flush` tells
          // committed and rolled-back apart on its own, so this runs
          // unconditionally on both paths.
          changes.flush();
        }
      }

      if (path.startsWith("/runs/") && path.endsWith("/events")) {
        // Only a GET opens a stream, for the same reason `/events` refuses
        // anything else below.
        if (req.method !== "GET") return sendJson(res, 405, { error: "a run's stream is read with GET" });
        const runId = path.slice("/runs/".length, path.length - "/events".length);
        const actor = resolveActor(store, readCookie(req.headers.cookie, SESSION_COOKIE), now());
        if (!actor) return sendJson(res, 401, { error: "not signed in" });
        // No user id ever comes from the client: the run id names a turn,
        // and the turn's session names the machine it ran on. Whoever paired
        // that machine is who may watch it — resolved from the cookie the
        // same way `/daemon/run/events`'s ownership check resolves a machine
        // from its bearer token.
        if (machineOwnerForTurn(store, runId) !== actor.userId)
          return sendJson(res, 403, { error: `run ${runId} does not belong to a machine you own` });

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.flushHeaders();

        // Every connection, first or resumed, begins from the latest durable
        // snapshot. A browser-held cursor can describe only what that one
        // browser saw; it is never more authoritative than the transactionally
        // persisted frame cursor, and replaying the relay directly on a fresh
        // connection would make fresh and resumed clients observe different
        // histories for the same run.

        let detach: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let settled = false;
        const end = () => {
          if (!openStreams.has(end)) return;
          openStreams.delete(end);
          if (heartbeat) clearInterval(heartbeat);
          detach?.();
          if (!res.writableEnded) res.end();
        };

        const send = (frame: RunEventFrame) => {
          if (res.writableEnded) return;
          try {
            res.write(`id: ${frame.seq}\nevent: frame\ndata: ${JSON.stringify(frame)}\n\n`);
          } catch {
            return end();
          }
          const terminalSnapshot =
            frame.event.event === "snapshot" &&
            (frame.event.snapshot.state.state === "completed" ||
              frame.event.snapshot.state.state === "failed" ||
              frame.event.snapshot.state.state === "cancelled");
          if (frame.event.event !== "completed" && !terminalSnapshot) return;
          if (terminalSnapshot) runs.markEnded(runId);
          settled = true;
          try {
            res.write(`event: end\ndata: {}\n\n`);
          } catch {
            // The write above already failed the same way; `end` below tears
            // the connection down regardless of whether this one did too.
          }
          end();
        };

        openStreams.add(end);
        req.on("close", end);
        // Subscribe without replay before reading storage. Frames persisted
        // and published while the authoritative snapshot is being read sit
        // behind this gate; once the snapshot cursor is known, only frames
        // strictly after it are released. The same ordering applies to a
        // fresh stream: its initial snapshot and first live frame cannot race.
        const queued: RunEventFrame[] = [];
        let gated = true;
        detach = runs.subscribe(runId, undefined, (frame) => {
          if (gated) queued.push(frame);
          else send(frame);
        });
        const stored = runSnapshot(store, runId);
        if (!stored) {
          end();
          return;
        }
        const {
          sessionId: _sessionId,
          machineId: _machineId,
          openedBy: _openedBy,
          ...publicSnapshot
        } = stored;
        const snapshot: ActiveRunSnapshot = publicSnapshot;
        send({
          seq: snapshot.lastEventSeq,
          event: { event: "snapshot", snapshot },
        });
        if (!settled) {
          gated = false;
          for (const frame of queued) {
            if (frame.seq > snapshot.lastEventSeq) send(frame);
            if (settled) break;
          }
        }
        if (res.writableEnded) return;

        heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(`: ping\n\n`);
          } catch {
            end();
          }
        }, 25_000);
        heartbeat.unref();
        return;
      }

      if (path === "/events") {
        // Only a GET opens a stream. Anything else would hang, holding a
        // connection open for a caller that is not going to read it.
        if (req.method !== "GET") return sendJson(res, 405, { error: "the event stream is read with GET" });
        const actor = resolveActor(store, readCookie(req.headers.cookie, SESSION_COOKIE), now());
        if (!actor) return sendJson(res, 401, { error: "not signed in" });

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        // Node holds the header block back and sends it with the first
        // body write, to batch small writes — exactly wrong for a stream
        // that may have nothing to replay. Without this, a subscriber who
        // connects to an otherwise quiet workspace sees no response at all,
        // not even that the connection opened, until the first heartbeat or
        // change gives Node a body write to piggyback the headers on.
        res.flushHeaders();

        // `Last-Event-ID` is what the browser resends on its own reconnect;
        // the query parameter is for a first connection that already knows
        // where it left off.
        const header = req.headers["last-event-id"];
        // An empty header is not a cursor of zero, for the same reason an
        // absent query parameter is not: `Number("")` is `0`.
        const fromHeader = typeof header === "string" && header !== "" ? Number(header) : NaN;
        const rawQuery = url.searchParams.get("cursor");
        // `Number(null)` is `0`, not `NaN` — an absent parameter must not
        // read as cursor 0, or a client's very first connection replays the
        // whole retained log (or an empty log's `seq > 0`, which happens to
        // read as "nothing", masking the bug until the log is non-empty)
        // instead of subscribing fresh the way "no cursor" is supposed to.
        const fromQuery = rawQuery === null ? NaN : Number(rawQuery);
        const cursor = Number.isInteger(fromHeader)
          ? fromHeader
          : Number.isInteger(fromQuery)
            ? fromQuery
            : undefined;

        // Declared before `channel.subscribe` runs, because a cursor's
        // replay calls `send` synchronously — before `subscribe` has
        // returned an unsubscribe function for `end` to close over.
        let unsubscribe: () => void = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const end = () => {
          // Idempotent: `req.on("close")`, a failed write, and the server
          // shutting down can each arrive, in any order.
          if (!openStreams.has(end)) return;
          openStreams.delete(end);
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          if (!res.writableEnded) res.end();
        };

        // A write after the socket is gone throws. Guarding `writableEnded`
        // catches the ordinary case; the `try/catch` is for the socket
        // dying in the gap before that flag is set.
        const send = (message: Send) => {
          if (res.writableEnded) return;
          try {
            if (message.type === "resync") {
              res.write(`event: resync\ndata: {}\n\n`);
            } else {
              res.write(
                `id: ${message.message.seq}\nevent: change\ndata: ${JSON.stringify(message.message)}\n\n`,
              );
            }
          } catch {
            end();
          }
        };

        // Registered before the replay rather than after it, so a write that
        // fails part-way through tears down through `end` like every other
        // failure instead of finding itself absent from `openStreams` and
        // returning without doing anything.
        openStreams.add(end);
        req.on("close", end);

        unsubscribe = channel.subscribe(cursor, send, {
          userId: actor.userId,
          disconnect: end,
        });
        if (res.writableEnded) return end();

        // Proxies close a stream that says nothing. A comment line is not an
        // event, so the client never sees it. `unref`'d so a stream nobody
        // closes cannot keep the process alive on its own, and `res.write`
        // is guarded the same way the subscriber callback is.
        heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(`: ping\n\n`);
          } catch {
            end();
          }
        }, 25_000);
        heartbeat.unref();
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD")
        return sendJson(res, 405, { error: "only GET is served here" });

      // The document is only ever served from the stamped shell. Reading
      // index.html off disk instead would hand back the unstamped file, and
      // a browser that cannot find the marker builds the in-browser demo —
      // so a researcher on their own lab's address would be shown fabricated
      // data and lose everything they wrote on the next reload.
      const relative = normalize(path);
      const isDocument = relative === "/" || relative === "/index.html";
      const file = join(config.uiDir, relative);
      // `join` cannot climb out of `uiDir` once the URL parser has collapsed
      // the path, but the separator keeps a sibling directory whose name
      // merely starts the same — `/srv/ui-private` against `/srv/ui` — from
      // satisfying a prefix test.
      const within = file === config.uiDir || file.startsWith(config.uiDir + sep);
      if (!isDocument && within) {
        try {
          const bytes = readFileSync(file);
          res.writeHead(200, {
            "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
            "x-content-type-options": "nosniff",
          });
          return res.end(bytes);
        } catch {
          // An address with a file extension was asking for an asset, and
          // there is no such asset. Answering with the shell would send HTML
          // under a script's content type and surface as a blank page.
          if (extname(relative) !== "")
            return sendJson(res, 404, { error: `no such file: ${relative}` });
        }
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexHtml);
    })().catch((err: unknown) => {
      console.error("[http] unhandled", err);
      if (!res.headersSent) sendJson(res, 500, { error: "the workspace server failed" });
    });
  };
}
