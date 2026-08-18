import { timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store";
import type { ChangeRecorder } from "../api/changes";
import { isLykeionError, type AgentOption, type ErrorCode } from "@lykeion/api";
import { hashSecret, newToken } from "../auth";
import { nextSeq } from "../store/migrations";
import { environmentStore } from "../store/environments";
import { buildEnvironmentOn, declareEnvironment, planFor } from "../api/environments";
import type { EnvSetupRegistry } from "../env-setup-registry";
import type { RunRelay } from "../run-relay";

/** The machine a bearer token names. */
export interface Machine {
  machineId: string;
  ownerId: string;
}

export interface DaemonRequest {
  store: Store;
  /** Where a route records what it changed. Pairing a machine changes the
   *  roster the same way admitting a member does, and is worth an owner
   *  seeing arrive. A heartbeat is not a change to anything a person reads —
   *  four of them a minute across every paired machine would flood the log
   *  with entries nobody asked to watch — so the heartbeat route never
   *  calls `record`, even though it is handed the same recorder. A report
   *  calls `record` only when what it found differs from what is already
   *  stored, since rewriting identical rows on a timer is not a change
   *  either. */
  changes: ChangeRecorder;
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
  now: number;
  /** The `kernel-env-setup` asks this lab is currently waiting on. Read, never
   *  settled, by `/daemon/kernel-env/lock` — which needs to know a machine
   *  posting a pin was actually asked to produce one. */
  envSetups: EnvSetupRegistry;
  /** The command queue a route reaches a machine over. Only
   *  `/daemon/kernel-env/packages` uses it: adding packages to a declaration
   *  is the one thing on this wire that has to send a command back down to
   *  the very machine that just called, so the software the researcher
   *  approved is actually built there. */
  runs: RunRelay;
}

export interface DaemonResult {
  status: number;
  json: unknown;
}

const BEARER_PREFIX = "Bearer ";

/**
 * The machine a bearer token names, or undefined. Mirrors `resolveActor` in
 * what it refuses: a revoked token is not a machine, neither is one whose
 * machine has since been removed, and neither is one whose owner has since
 * left the lab — the membership join is what makes offboarding immediate
 * for a machine token the same way it already is for a session.
 */
export function resolveMachine(store: Store, authorization: string | undefined): Machine | undefined {
  if (!authorization || !authorization.startsWith(BEARER_PREFIX)) return undefined;
  const token = authorization.slice(BEARER_PREFIX.length);
  if (!token) return undefined;
  const row = store.get(
    `SELECT t.runtime_id AS runtime_id, t.owner_id AS owner_id
       FROM machine_tokens t
       JOIN runtimes r ON r.id = t.runtime_id
       JOIN members m ON m.user_id = t.owner_id
      WHERE t.token_hash = ?
        AND t.revoked_ts IS NULL
        AND r.removed_ts IS NULL
        AND m.removed_ts IS NULL`,
    [hashSecret(token)],
  );
  if (!row) return undefined;
  return { machineId: row.runtime_id as string, ownerId: row.owner_id as string };
}

const OWNED_ROUTES = new Set([
  "POST /daemon/pair/exchange",
  "POST /daemon/heartbeat",
  "POST /daemon/report",
  "POST /daemon/workspaces",
  "POST /daemon/kernel-envs",
  "POST /daemon/kernel-env/create",
  "POST /daemon/kernel-env/packages",
  "POST /daemon/kernel-env/lock",
]);

function field(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value : "";
}

function stringArrayField(body: unknown, name: string): string[] {
  const value = (body as Record<string, unknown> | null)?.[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** The raw value of an array-typed field, or `undefined` when the field is
 *  absent or is not an array at all — the caller decides whether that is
 *  refused outright or treated as empty. */
function arrayField(body: unknown, name: string): unknown[] | undefined {
  const value = (body as Record<string, unknown> | null)?.[name];
  return Array.isArray(value) ? value : undefined;
}

/** The raw value of a number-typed field, or `undefined` when it is absent
 *  or not a finite number. A daemon built before `totalMemoryBytes`/`cores`
 *  existed sends neither, and `undefined` here is what lets the write path
 *  store SQL NULL for it rather than inventing a zero nothing measured. */
function numberField(body: unknown, name: string): number | undefined {
  const value = (body as Record<string, unknown> | null)?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The raw value of a string-typed field, or `undefined` when it is absent
 *  or not a string — unlike `field`, which answers a required field with the
 *  empty string. `processVisibility` is optional the same way
 *  `totalMemoryBytes` is: a daemon built before it existed sends nothing,
 *  and `undefined` is what lets that read as "never said" rather than as an
 *  empty sentence. */
function optionalStringField(body: unknown, name: string): string | undefined {
  const value = (body as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value : undefined;
}

/** What a report says about the kernel floor: whether this machine meets it,
 *  and why not when it does not. `undefined` on BOTH when the field is
 *  missing or malformed — a daemon too old to probe the floor has said
 *  nothing, which must read the same as never having asked, not as a claim
 *  the machine failed a check that never ran. */
function kernelsField(body: unknown): { ready: boolean | undefined; reason: string | undefined } {
  const value = (body as Record<string, unknown> | null)?.kernels;
  if (value === null || typeof value !== "object") return { ready: undefined, reason: undefined };
  const row = value as Record<string, unknown>;
  return {
    ready: typeof row.ready === "boolean" ? row.ready : undefined,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

/** One CLI as a report's body carries it — the same shape as `AgentCli`,
 *  minus the `machineId` a report has no reason to name itself. `sessionReady`
 *  is read leniently, not required: a daemon built before this field existed
 *  says nothing about it, and silence is read as "not session-ready" rather
 *  than trusted as a claim nobody actually made. */
interface ReportedCli {
  id: string;
  name: string;
  command: string;
  version: string;
  available: boolean;
  sessionReady: boolean;
  sessionReadyReason?: string;
  /** What the agent advertised when a session was opened with it. ABSENT
   *  when no session could be opened to ask, which is not the same as an
   *  agent that advertised nothing. */
  options?: AgentOption[];
  /** Whether the CLI is signed in. ABSENT when nothing got far enough to
   *  ask, which is not the same as a CLI that answered no — see
   *  `AgentCli.signedIn`, and the nullable column behind it. */
  signedIn?: boolean;
  account?: string;
  heldBackReason?: string;
  adapterProvenance?: "vendor" | "protocol" | "community";
}

/** Malformed entries are dropped rather than failing the whole report: a
 *  machine daemon builds this body itself, so a single garbled entry is not
 *  reason to lose the rest of what it found. A later entry sharing an
 *  earlier one's id is dropped too, keeping the first — `runtime_clis` keys
 *  on `(runtime_id, cli_id)`, so a second entry for the same id can only
 *  fail the insert, never usefully update anything the first one wrote a
 *  moment before it in the same body. */
function parseClis(entries: unknown[]): ReportedCli[] {
  const out: ReportedCli[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.command !== "string" ||
      typeof row.version !== "string" ||
      typeof row.available !== "boolean"
    )
      continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const cli: ReportedCli = {
      id: row.id,
      name: row.name,
      command: row.command,
      version: row.version,
      available: row.available,
      sessionReady: row.sessionReady === true,
    };
    if (typeof row.sessionReadyReason === "string") cli.sessionReadyReason = row.sessionReadyReason;
    if (Array.isArray(row.options)) cli.options = row.options as AgentOption[];
    // Read as three-valued on purpose: `true`, `false`, and not sent. Anything
    // that is not a boolean is not an answer, and is stored as none.
    if (typeof row.signedIn === "boolean") cli.signedIn = row.signedIn;
    if (typeof row.account === "string") cli.account = row.account;
    if (typeof row.heldBackReason === "string") cli.heldBackReason = row.heldBackReason;
    if (row.adapterProvenance === "vendor" || row.adapterProvenance === "protocol" || row.adapterProvenance === "community")
      cli.adapterProvenance = row.adapterProvenance;
    out.push(cli);
  }
  return out;
}

/**
 * Whether two CLI sets differ, compared on `(cli_id, version, available,
 * sessionReady, options)` — a name or command changing without any of those
 * is not a fact this lab needs to hear about again.
 *
 * The options are in the comparison for the same reason the daemon's own
 * `cliFingerprint` counts them, and the two gates have to agree or the
 * report the daemon took care to send dies on arrival. A probe that reaches
 * an adapter but cannot open a throwaway session — a cold start, a CLI not
 * signed in — reports the agent ready with its options UNKNOWN, an ordinary
 * outcome; the probe that opens one later reports the whole catalogue with
 * every other field identical. Compared without the options, that second
 * report reads as a repeat of the first: the row IS rewritten, but nothing
 * is announced, so every page already open keeps the snapshot it loaded and
 * goes on offering a bare *Default* against an agent with a catalogue to
 * give. Nothing else corrects it — a real session reads what the agent
 * advertises but keeps it to itself — so the researcher's only way out is a
 * reload they have no reason to know they need.
 *
 * Compared as the column stores them, which is what the daemon sent: a
 * repeated report re-serializes the same body to the same text. An agent
 * that advertised nothing (`[]`) and one no session could be opened against
 * (`null`) are different answers here, as they are everywhere else.
 */
function cliSetChanged(
  stored: StoredCli[],
  reported: ReportedCli[],
  optionsOf: (cli: ReportedCli) => string | null,
): boolean {
  if (stored.length !== reported.length) return true;
  // Keyed as JSON rather than a delimited string: a version is free-form and
  // routinely holds spaces ("2.1.226 (Claude Code)"), so a separator that can
  // occur inside a field cannot be what tells the fields apart.
  const key = (row: {
    id: string;
    version: string;
    available: boolean;
    sessionReady: boolean;
    options: string | null;
    signedIn: boolean | undefined;
    account: string | undefined;
    heldBackReason: string | undefined;
    adapterProvenance: string | undefined;
  }) =>
    JSON.stringify([
      row.id,
      row.version,
      row.available,
      row.sessionReady,
      row.options,
      // `null` where the column is empty and `undefined` where the report
      // said nothing both serialize to the same thing inside an array, which
      // is what makes comparing the two shapes honest.
      row.signedIn ?? null,
      row.account ?? null,
      row.heldBackReason ?? null,
      row.adapterProvenance ?? null,
    ]);
  const storedKeys = new Set(
    stored.map((row) =>
      key({
        id: row.cliId,
        version: row.version,
        available: row.available,
        sessionReady: row.sessionReady,
        options: row.options,
        signedIn: row.signedIn,
        account: row.account,
        heldBackReason: row.heldBackReason,
        adapterProvenance: row.adapterProvenance,
      }),
    ),
  );
  return reported.some(
    (cli) =>
      !storedKeys.has(
        key({
          id: cli.id,
          version: cli.version,
          available: cli.available,
          sessionReady: cli.sessionReady,
          options: optionsOf(cli),
          signedIn: cli.signedIn,
          account: cli.account,
          heldBackReason: cli.heldBackReason,
          adapterProvenance: cli.adapterProvenance,
        }),
      ),
  );
}

interface StoredCli {
  cliId: string;
  version: string;
  available: boolean;
  sessionReady: boolean;
  options: string | null;
  signedIn: boolean | undefined;
  account: string | undefined;
  heldBackReason: string | undefined;
  adapterProvenance: string | undefined;
}

/**
 * What each agent's options column should hold after this report — the one
 * answer the comparison above and the insert below both read, so they can
 * never disagree about what "unchanged" means.
 *
 * A report that says nothing about what an agent offers leaves standing
 * whatever this lab was last told. UNKNOWN is the ABSENCE of information and
 * must never replace information: `session/new` against a real CLI
 * authenticates and enumerates, which is slow enough to sit near the probe's
 * own timeout and is slowest exactly when the machine is busy — that is,
 * while somebody is using this product. Written straight through, one such
 * probe wipes a catalogue the lab holds perfectly good, and the composer
 * drops to a bare *Default* until some later probe happens to succeed. That
 * is the picker emptying itself for no reason a researcher did anything to
 * cause, and no reason they can act on.
 *
 * An EMPTY list is not that. It is an agent that opened a session and offered
 * nothing, which is an answer, and it lands — otherwise an agent that drops
 * its options would go on advertising a catalogue it no longer has.
 */
/** The raw value of an `environments` report field, JSON-encoded for
 *  storage — `null` when the field is absent or malformed (a daemon too old
 *  to report this, or one whose ask for the declared list failed this
 *  cycle), never an invented empty array. See migration 26: NULL is "never
 *  reported", not "reported holding nothing". */
function environmentsField(body: unknown): string | null {
  const value = arrayField(body, "environments");
  return value === undefined ? null : JSON.stringify(value);
}

function optionsKeeper(stored: StoredCli[]): (cli: ReportedCli) => string | null {
  const held = new Map(stored.map((row) => [row.cliId, row.options]));
  return (cli) =>
    cli.options === undefined ? (held.get(cli.id) ?? null) : JSON.stringify(cli.options);
}

/**
 * Whether two secret-derived strings match, without leaking how far the
 * comparison got before it found a difference. `timingSafeEqual` requires
 * equal-length buffers; unequal lengths are refused outright rather than
 * padded, since padding would itself have to be constant-time to be worth
 * anything.
 */
function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function exchange(req: DaemonRequest): DaemonResult {
  const { store, changes, body, now } = req;
  const code = field(body, "code");
  const verifier = field(body, "verifier");
  if (!code || !verifier) return { status: 400, json: { error: "a code and a verifier are required" } };

  const codeHash = hashSecret(code);
  let failure: string | undefined;
  let success: { token: string; runtimeId: string; machineName: string; labName: string } | undefined;

  store.tx(() => {
    const request = store.get(
      `SELECT * FROM pair_requests WHERE code_hash = ? AND spent_ts IS NULL AND expires_ts > ?`,
      [codeHash, now],
    );
    if (!request) {
      failure = "that pairing code is not valid";
      return;
    }
    // Spent from here on, whatever happens next: a wrong verifier must not
    // leave the code alive for a second, better-informed guess. The code
    // travels through the address bar and into browser history, so the
    // verifier — never published, held only by the daemon that minted the
    // challenge — is what stands between that history and a stolen machine.
    store.run(`UPDATE pair_requests SET spent_ts = ? WHERE code_hash = ?`, [now, codeHash]);

    if (!secretsMatch(hashSecret(verifier), request.challenge as string)) {
      failure = "that verifier does not match";
      return;
    }

    const seq = nextSeq(store);
    const machineId = `rt_${seq}`;
    store.run(
      `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        machineId,
        request.owner_id,
        request.name,
        request.platform,
        request.daemon_version,
        "[]",
        now,
        now,
        seq,
      ],
    );
    const token = newToken();
    store.run(
      `INSERT INTO machine_tokens (token_hash, runtime_id, owner_id, created_ts, seq) VALUES (?, ?, ?, ?, ?)`,
      [hashSecret(token), machineId, request.owner_id, now, nextSeq(store)],
    );
    changes.record("runtime-paired", {}, request.owner_id as string);
    const lab = store.get(`SELECT org_name FROM lab_settings WHERE id = 1`);
    success = {
      token,
      // The key the daemon reads off this response, and the one thing here
      // that could not be renamed with the rest: `lab.ts` on the machine
      // parses `body.runtimeId`, and a daemon already paired is not upgraded
      // in step with the lab it is paired to.
      runtimeId: machineId,
      machineName: request.name as string,
      labName: (lab?.org_name as string | undefined) ?? "",
    };
  });

  if (failure) return { status: 400, json: { error: failure } };
  return { status: 200, json: success };
}

/** A report is contact with the machine the same way a heartbeat is — a
 *  daemon that reported a second ago is plainly not offline — so both move
 *  `last_seen_ts`, and this is the one place either does it. */
function touchLastSeen(store: Store, machineId: string, ts: number): void {
  store.run(`UPDATE runtimes SET last_seen_ts = ? WHERE id = ?`, [ts, machineId]);
}

function heartbeat(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  touchLastSeen(req.store, machine.machineId, req.now);
  return { status: 200, json: { ok: true } };
}

/**
 * Which of the Studies and Tasks a machine holds a working directory for
 * this lab no longer has. A Task's directory holds the work of every turn
 * that Task has run, so a machine keeps it for as long as the Task exists
 * rather than ageing it out on a timer; this is how it finds out that one
 * of them stopped existing.
 *
 * It answers about the ids it was asked about and no others, so it can never
 * be read as a listing of what this lab holds.
 */
function workspaces(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  const studyIds = stringArrayField(req.body, "studyIds").filter(
    (id) => !req.store.get(`SELECT id FROM studies WHERE id = ?`, [id]),
  );
  const taskIds = stringArrayField(req.body, "taskIds").filter(
    (id) => !req.store.get(`SELECT id FROM tasks WHERE id = ?`, [id]),
  );
  return { status: 200, json: { studyIds, taskIds } };
}

/**
 * What a machine says about itself on every report: its platform, its
 * daemon build, what it can do, and the agent CLIs it found — including,
 * per CLI, whether its adapter actually handshakes and, when it does not,
 * what it refused with. `platform` and `daemonVersion` empty, or `clis`
 * missing or not an array, is refused outright — a body that arrived that
 * broken is not something to write over what is already stored on the
 * strength of a guess. The CLI rows are replaced wholesale inside one
 * transaction — a daemon always reports the whole set it found, never a
 * delta, so there is nothing to reconcile row by row. A change is recorded
 * only when something an owner would actually see on the Machines screen is
 * different from what is already stored: the reported platform, daemon
 * version, or capabilities, the machine's own memory or core count, or the
 * CLI set compared on `(cli_id, version, available, sessionReady)`. Never
 * more than one entry, whatever combination of those changed.
 */
function report(req: DaemonRequest): DaemonResult {
  const { store, body } = req;
  const machine = resolveMachine(store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };

  const platform = field(body, "platform");
  const daemonVersion = field(body, "daemonVersion");
  const clisField = arrayField(body, "clis");
  if (!platform || !daemonVersion || clisField === undefined)
    return { status: 400, json: { error: "a platform, a daemonVersion, and a clis array are required" } };

  const capabilities = stringArrayField(body, "capabilities");
  const clis = parseClis(clisField);
  const capabilitiesJson = JSON.stringify(capabilities);
  // Absent, not zero, on a report that says nothing about either — a daemon
  // built before this pair of fields existed sends neither, and writing 0
  // here would tell `computeSnapshot` a real machine had no memory and no
  // cores rather than that nobody has said yet.
  const totalMemoryBytes = numberField(body, "totalMemoryBytes") ?? null;
  const cores = numberField(body, "cores") ?? null;
  // NULL on both when the field is missing or malformed, the same "never
  // asked" the column itself is nullable for — see migration 24.
  const { ready: kernelsReadyField, reason: kernelsReasonField } = kernelsField(body);
  const kernelsReady = kernelsReadyField === undefined ? null : kernelsReadyField ? 1 : 0;
  // Never present when `kernelsReady` is anything but 0 — `probeKernelFloor`
  // never sets a reason beside `ready: true` — but read leniently rather
  // than asserted, the same way every other reported reason in this file is.
  const kernelsReason = kernelsReasonField ?? null;
  const processVisibility = optionalStringField(body, "processVisibility") ?? null;
  const environments = environmentsField(body);

  store.tx(() => {
    const current = store.get(
      `SELECT platform, daemon_version, capabilities, total_memory_bytes, cores,
              kernels_ready, kernels_reason, process_visibility, environments
         FROM runtimes WHERE id = ?`,
      [machine.machineId],
    )!;
    const existing = store
      .all(
        `SELECT cli_id, version, available, session_ready, options,
                signed_in, account, held_back_reason, adapter_provenance
           FROM runtime_clis WHERE runtime_id = ?`,
        [machine.machineId],
      )
      .map((row) => ({
        cliId: row.cli_id as string,
        version: row.version as string,
        available: row.available === 1,
        sessionReady: row.session_ready === 1,
        options: (row.options as string | null) ?? null,
        // NULL is a CLI nothing asked, which is not the same as one that
        // answered no — the column is nullable for exactly this.
        signedIn: row.signed_in === null || row.signed_in === undefined ? undefined : row.signed_in === 1,
        account: (row.account as string | null) ?? undefined,
        heldBackReason: (row.held_back_reason as string | null) ?? undefined,
        adapterProvenance: (row.adapter_provenance as string | null) ?? undefined,
      }));

    const metaChanged =
      current.platform !== platform ||
      current.daemon_version !== daemonVersion ||
      current.capabilities !== capabilitiesJson ||
      // Memory and Processor are on the Machines screen too, same as
      // platform and daemon version — a machine whose RAM or core count
      // changed is a change an owner would see there.
      current.total_memory_bytes !== totalMemoryBytes ||
      current.cores !== cores ||
      // Whether this machine can host a kernel is on the same screen, and the
      // sentence naming what it is missing changes exactly when this does.
      current.kernels_ready !== kernelsReady ||
      current.kernels_reason !== kernelsReason ||
      current.process_visibility !== processVisibility ||
      // What this machine holds of each declared environment is on the
      // Machines screen too (D2) — a build finishing, or a machine losing
      // one, is a change an owner would see there.
      //
      // A report that carried no environments at all changes nothing, and
      // must not be recorded as a change: the write below keeps whatever was
      // last heard, so a comparison that fired here would announce a
      // difference the column never took.
      (environments !== null && current.environments !== environments);
    // Read once, before the delete below takes the rows this reads from out.
    const optionsFor = optionsKeeper(existing);
    const changed = metaChanged || cliSetChanged(existing, clis, optionsFor);

    // `environments` is COALESCEd rather than assigned: `lab.ts`'s own
    // contract says a machine that could not build the list omits the field
    // rather than sending an empty one, and `main.ts` does exactly that when
    // `fetchKernelEnvDeclarations` fails — while still sending the report,
    // since the fingerprint differs. A plain assignment would blank a machine
    // that has reported honestly many times, leaving it reading as "has not
    // reported" on the Machines screen: precisely the ambiguity this column
    // was persisted to remove. Every other column here is genuinely resent on
    // every report, so only this one needs keeping.
    store.run(
      `UPDATE runtimes SET platform = ?, daemon_version = ?, capabilities = ?, last_seen_ts = ?,
              total_memory_bytes = ?, cores = ?, kernels_ready = ?, kernels_reason = ?,
              process_visibility = ?, environments = COALESCE(?, environments) WHERE id = ?`,
      [
        platform,
        daemonVersion,
        capabilitiesJson,
        req.now,
        totalMemoryBytes,
        cores,
        kernelsReady,
        kernelsReason,
        processVisibility,
        environments,
        machine.machineId,
      ],
    );
    store.run(`DELETE FROM runtime_clis WHERE runtime_id = ?`, [machine.machineId]);
    for (const cli of clis) {
      store.run(
        `INSERT INTO runtime_clis
           (runtime_id, cli_id, name, command, version, available, session_ready,
            session_ready_reason, options, signed_in, account, held_back_reason,
            adapter_provenance, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          machine.machineId,
          cli.id,
          cli.name,
          cli.command,
          cli.version,
          cli.available ? 1 : 0,
          cli.sessionReady ? 1 : 0,
          cli.sessionReadyReason ?? null,
          // An empty list and no list at all are different answers, so an
          // agent that advertised nothing is stored as `[]` while one no
          // session could be opened against keeps whatever this lab already
          // held — NULL only when it never held anything.
          optionsFor(cli),
          // NULL rather than 0 when the report said nothing, so "nobody
          // asked" survives the round trip as itself.
          cli.signedIn === undefined ? null : cli.signedIn ? 1 : 0,
          cli.account ?? null,
          cli.heldBackReason ?? null,
          cli.adapterProvenance ?? null,
          nextSeq(store),
        ],
      );
    }

    if (changed) req.changes.record("runtime-clis-changed", {}, machine.ownerId);
  });

  return { status: 200, json: { ok: true } };
}

/**
 * Every environment this lab has declared, lab-wide rather than
 * owner-scoped: any paired machine may resolve any declared environment
 * (D2's declaration is a fact about the lab, not about whoever created it),
 * so any paired machine may read the list it needs before it can say what
 * it holds of each one — both for a `kernel-env-setup` command's own
 * `packages`/`lockfile`, minted on the lab's side of the wire, and for this
 * machine's own regular report, which reads `readEnvStatus` against this
 * same list.
 */
function kernelEnvs(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  return { status: 200, json: { declarations: environmentStore(req.store).list() } };
}

/** What status a typed refusal from `declareEnvironment` goes out as. The
 *  daemon reads the body's `error` either way (`callLab` in the daemon's
 *  `lab.ts`), so what this decides is whether a client that branches on
 *  status can tell "the name is unusable" from "that name is taken" — and
 *  a researcher who has just approved a card is owed the difference. */
const STATUS_FOR: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  invalid: 400,
  unsupported: 422,
};

/**
 * Declares one environment on behalf of an agent whose researcher has just
 * allowed it, and answers with the declaration.
 *
 * The declaration is attributed to the SESSION's owner, never to the
 * machine's. A bearer token proves that some paired machine is calling; it
 * says nothing about which person's work is being done on it, and it is
 * shared by every session that machine is running. Only the session names
 * the researcher.
 *
 * Which is also why the session has to be this machine's. Without that
 * check, any paired machine in the lab could declare environments attributed
 * to any colleague, by naming their session id — an id it is not hard to
 * come by, since the lab hands one to every machine a session is opened on.
 * The token says which machine; only the session says which person; and the
 * two have to agree.
 */
/**
 * The researcher whose session `sessionId` is, or the one refusal that keeps
 * a machine off a session that is not its own.
 *
 * Extracted rather than written twice: both environment-changing routes
 * authenticate a MACHINE and attribute to a PERSON, and a second copy of
 * this check would drift into a route where one of the three facts it
 * refuses on is no longer refused.
 *
 * One refusal for those three facts — no such session, one that has ended,
 * one belonging to another machine — because a machine that is not running
 * that session has no business learning which of the three it was.
 */
function researcherOfSession(
  store: Store,
  machine: Machine,
  sessionId: string,
): { openedBy: string } | undefined {
  const session = store.get(
    `SELECT opened_by AS opened_by, runtime_id AS runtime_id
       FROM sessions WHERE id = ? AND ended_ts IS NULL`,
    [sessionId],
  );
  if (!session || session.runtime_id !== machine.machineId) return undefined;
  return { openedBy: session.opened_by as string };
}

const NOT_THIS_MACHINES_SESSION = {
  status: 403,
  json: { error: "this machine is not running a session with that id" },
};

function kernelEnvCreate(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  const sessionId = field(req.body, "sessionId");
  const name = field(req.body, "name");
  const packages = arrayField(req.body, "packages");
  // An absent `packages` is not an empty one — an environment holding only
  // its interpreter is something a caller says, not something inferred from
  // a field nobody sent. A list holding anything but a package name is
  // refused whole rather than filtered: a filtered list is a declaration
  // this lab pins for every machine that differs from the one it was sent.
  if (
    !sessionId ||
    !name ||
    packages === undefined ||
    !packages.every((entry): entry is string => typeof entry === "string" && entry !== "")
  )
    return {
      status: 400,
      json: { error: "a sessionId, a name and a list of package names are required" },
    };
  const session = researcherOfSession(req.store, machine, sessionId);
  if (!session) return NOT_THIS_MACHINES_SESSION;
  try {
    const declaration = declareEnvironment(
      req.store,
      (kind, payload, ownerId) => req.changes.record(kind, payload, ownerId),
      // Python only, this phase (D1) — there is no R environment for a
      // caller to name, so nothing on this wire carries a language.
      { name, language: "python", packages },
      session.openedBy,
      req.now,
    );
    return { status: 200, json: { declaration } };
  } catch (err) {
    // The lab's own sentence travels: the researcher just approved this
    // card, and "it failed" with no reason is the worst possible answer to
    // one they said yes to.
    if (isLykeionError(err)) return { status: STATUS_FOR[err.code], json: { error: err.message } };
    throw err;
  }
}

/** What one rebuild is FOR, in words a kernel's ending can carry: "scanpy
 *  was added to python". Built here, from what was actually added, because
 *  this is the only place that knows the difference between what was asked
 *  for and what the declaration did not already hold. */
function whyRebuilding(added: string[], name: string): string {
  return added.length === 1
    ? `${added[0]} was added to ${name}`
    : `${added.join(", ")} were added to ${name}`;
}

/** What the same rebuild is FOR when the call that asked for it added
 *  NOTHING: everything it named is already declared, and the build is a retry
 *  of one this lab never got — not a new request. A kernel's ending carries
 *  this sentence, so it has to be true of what actually happened. */
function whyCatchingUp(asked: string[], name: string): string {
  return `${name} already declared ${asked.join(", ")} and had not been built with them here yet`;
}

/**
 * Whether this lab still owes `name` a build — `planFor`'s own derivation,
 * asked as a question.
 *
 * This is what makes a retry the recovery. `envs.addPackages` answers `added:
 * []` for a package the declaration already names, so an agent whose build
 * FAILED — a network blip mid-`uv pip sync`, a machine that never came back —
 * asking again for the same package would otherwise be told nothing was added
 * and no build is running, with the package still not installed and no call
 * anywhere able to trigger one. The declaration is ahead of the pin in
 * exactly that state, which is precisely what `planFor` derives, so the
 * question is asked of the derivation that already exists rather than of a
 * flag that could disagree with it.
 *
 * `false` where the question cannot be asked at all. `planFor` throws for a
 * declaration deleted underneath this call and for a pinned revision whose
 * text this lab does not hold; neither is a build this route can usefully
 * dispatch, and answering `false` claims only that no build is running
 * because of this call, which is exactly true. The second of those is a
 * broken store, and `kernelEnvSetup` already refuses it by name in front of a
 * researcher who can act on it.
 */
function buildStillOwed(store: Store, name: string): boolean {
  try {
    return planFor(store, name).resolve;
  } catch {
    return false;
  }
}

/**
 * Adds packages to an environment this lab already declares, on behalf of an
 * agent whose researcher has just allowed it — and asks the calling machine
 * to rebuild its own copy.
 *
 * The attribution rules are `kernelEnvCreate`'s exactly, and reached through
 * the same helper: the token names the MACHINE, only the session names the
 * PERSON, and the two have to agree.
 *
 * **Appends.** The declaration keeps everything it already held; see
 * `environmentStore.addPackages`. A call adding only names already declared
 * changes nothing and records nothing — it is the state the caller asked for,
 * already reached, and `added: []` is how the answer says so.
 *
 * **But `added: []` is not "nothing to do".** Whether the DECLARATION moved
 * and whether a BUILD is owed are two questions, and they come apart in
 * exactly the state a failed build leaves: the package is declared, so
 * nothing is appended, and no build ever landed, so the pin never moved and
 * no machine holds it. Asked again there, this route dispatches the build
 * anyway (`buildStillOwed`) and answers `building: true` — the retry IS the
 * recovery. Without it a declaration can sit permanently ahead of every
 * machine in the lab: `KernelEnvCard`'s "a revision behind" cannot fire,
 * because the declaration's `lockRevision` never moved either, and no other
 * call anywhere re-triggers a build for a package that is already declared.
 *
 * **Then the rebuild, on the calling machine.** No cross-machine
 * authorization question arises: `authorizedOwnRuntime`'s ownership check
 * ("only the member who paired a machine may set up environments on it")
 * exists to stop one researcher directing another's laptop, and this route
 * directs nobody — the machine it dispatches to is the one whose bearer
 * token authenticated the call, rebuilding its own copy. That token is the
 * fact standing in for the ownership check; the session, checked above,
 * stands in for the actor the check was written against. Its offline check
 * is likewise moot: a machine that is posting to this route is connected.
 *
 * **Not awaited.** This route answers synchronously, and a `uv` resolve plus
 * a materialize is minutes — held open, it would be an MCP tool call and an
 * HTTP request both parked for the length of a package download. The answer
 * says a build is running instead, which is what the tool then has to tell
 * the model so it does not import something that is not there yet.
 */
function kernelEnvPackages(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  const sessionId = field(req.body, "sessionId");
  const name = field(req.body, "name");
  const packages = arrayField(req.body, "packages");
  // An EMPTY list is refused here, unlike a create's: an environment holding
  // only its interpreter is something a caller can mean, but an ADD of
  // nothing is not a state anyone can be asking for. A list holding anything
  // but a package name is refused whole rather than filtered, for the reason
  // a create's is: a filtered list is software this lab installs on every
  // machine that differs from what the researcher approved.
  if (
    !sessionId ||
    !name ||
    packages === undefined ||
    packages.length === 0 ||
    !packages.every((entry): entry is string => typeof entry === "string" && entry !== "")
  )
    return {
      status: 400,
      json: { error: "a sessionId, a name and at least one package name are required" },
    };
  const session = researcherOfSession(req.store, machine, sessionId);
  if (!session) return NOT_THIS_MACHINES_SESSION;
  const envs = environmentStore(req.store);
  const declaration = envs.get(name);
  // 404 rather than a create in disguise. `manage_packages` adds to what
  // exists; a name this lab does not declare is a different request, asked
  // on a different card, and answering it here would install software under
  // a question the researcher was never shown.
  if (declaration === undefined)
    return { status: 404, json: { error: `this lab declares no environment named ${name}` } };

  const { packages: held, added } = envs.addPackages(name, packages);
  // Recorded only for a real append. A call that added nothing wrote nothing,
  // and a change-log row for it would be this lab reporting a declaration
  // that moved when it did not.
  if (added.length > 0)
    req.changes.record("environment-packages-added", { name, packages: added }, session.openedBy);
  // Two questions, and `added` only answers the first. What was appended
  // decides whether the DECLARATION moved; whether this lab's pin still
  // answers that declaration decides whether a BUILD is owed. They come apart
  // exactly when a previous build failed: the declaration already names the
  // package, so nothing is appended, and the pin never moved, so nothing on
  // any machine holds it. Asked again in that state the caller is the retry,
  // and refusing to dispatch would leave the lab permanently declared past
  // every machine with no surface able to say so and no call able to fix it.
  if (added.length === 0 && !buildStillOwed(req.store, name))
    return {
      status: 200,
      json: { declaration: { ...declaration, packages: held }, added, building: false },
    };

  const reason = added.length > 0 ? whyRebuilding(added, name) : whyCatchingUp(packages, name);
  // Dispatched, never awaited — see the note above. The rejection is
  // swallowed rather than reported: this call has already written the
  // declaration every machine in the lab builds from, and a machine that
  // cannot be reached down its own command stream right now is a machine
  // whose researcher will click Setup, or whose next session will find the
  // environment missing and say so by name.
  const machineName = req.store.get(`SELECT name FROM runtimes WHERE id = ?`, [
    machine.machineId,
  ])?.name as string | undefined;
  void buildEnvironmentOn(
    { store: req.store, runs: req.runs, envSetups: req.envSetups },
    { machineId: machine.machineId, name: machineName ?? machine.machineId },
    name,
    // What THIS call is owed — the declaration its own append just produced.
    // A build already in flight was planned before these packages existed, so
    // joining it is not the same as being satisfied by it; `buildEnvironmentOn`
    // compares this list against what the build it joined actually covered and
    // asks for another round when they are not in it.
    held,
    reason,
  ).catch(() => {});
  return {
    status: 200,
    json: { declaration: { ...declaration, packages: held }, added, building: true, reason },
  };
}

/**
 * Hands this lab a lockfile a machine just resolved, and answers with the
 * revision it became. Synchronous, unlike the machine's own final
 * `kernel-env-setup` result: `materializeEnvironment` needs the revision
 * BEFORE it can build, since the completion marker records which revision
 * this machine actually built from, and nothing can name it before this
 * write happens.
 *
 * Refuses a name this lab no longer declares — the one race this route has
 * to answer for honestly, rather than let the raw foreign-key constraint on
 * `kernel_env_locks` throw: a declaration a researcher deleted while a
 * first-ever resolve was still in flight on some machine leaves that
 * machine with a lockfile for a name this lab no longer recognizes.
 *
 * Bound to an outstanding ask to RESOLVE this environment — machine,
 * request and name, and the ask itself. The bearer token proves some paired
 * machine is calling and never that it is the one this lab asked, and a pin
 * is the single most consequential thing on this wire: every OTHER machine
 * replays a lockfile verbatim (D4), so a machine allowed to write one it was
 * never asked for would repin an environment lab-wide and have every
 * colleague faithfully reproduce it. Checking the name too is what keeps a
 * machine building `foo` from pinning `bar` during its own build window. The
 * pinning mechanism exists so two machines cannot disagree; it must not be
 * the way one machine overrules the rest.
 *
 * And a machine sent a REPLAY has no pin to post at all: it was handed this
 * lab's own lockfile and asked to materialize it, and `oneSetup` records
 * that by sending no `resolvedFrom` with the ask. Accepted anyway, its text
 * would become a revision this lab cannot say what was resolved from — which
 * is precisely the state `planFor` answers by widening every other machine
 * to `resolve`. One materialize-only machine would turn D4 off lab-wide for
 * that environment, durably, and every colleague would re-resolve
 * independently from then on. `askedToResolve` is what refuses it.
 */
function kernelEnvLock(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  const requestId = field(req.body, "requestId");
  const name = field(req.body, "name");
  const lockfile = field(req.body, "lockfile");
  if (!requestId || !name || !lockfile)
    return { status: 400, json: { error: "a requestId, a name and a lockfile are required" } };
  // Read rather than settled: this machine is still mid-build and this lab
  // goes on waiting for the result that follows.
  if (!req.envSetups.askedToResolve(machine.machineId, requestId, name))
    return { status: 403, json: { error: "this machine was not asked to resolve that environment" } };
  const envs = environmentStore(req.store);
  if (envs.get(name) === undefined)
    return { status: 404, json: { error: `this lab no longer declares an environment named ${name}` } };
  // What THIS lab asked to be resolved, written beside the text it produced
  // — never the declaration as it reads at this instant. The declaration can
  // have grown while the resolve was running (that is precisely what
  // `manage_packages` does), and stamping the pin with the newer list would
  // claim the lockfile covers packages it was never resolved from. The next
  // machine would then replay it and silently hold none of them.
  const resolvedFrom = req.envSetups.resolvedFrom(machine.machineId, requestId, name);
  const lockRevision = envs.writeLock(name, lockfile, req.now, resolvedFrom);
  req.changes.record("environment-lock-written", { name }, machine.ownerId);
  return { status: 200, json: { lockRevision } };
}

/**
 * The surface a daemon talks to once it has a code, or a token. Exchange
 * carries neither an existing identity nor a session — a bearer token is
 * what it is trying to obtain — so it alone answers with no authorization
 * required; every other route here requires one. Returns `undefined` for
 * any path this module does not own, so the caller can go on routing.
 */
export function handleDaemonRoute(req: DaemonRequest): DaemonResult | undefined {
  if (!OWNED_ROUTES.has(`${req.method} ${req.path}`)) return undefined;
  if (req.path === "/daemon/pair/exchange") return exchange(req);
  if (req.path === "/daemon/report") return report(req);
  if (req.path === "/daemon/workspaces") return workspaces(req);
  if (req.path === "/daemon/kernel-envs") return kernelEnvs(req);
  if (req.path === "/daemon/kernel-env/create") return kernelEnvCreate(req);
  if (req.path === "/daemon/kernel-env/packages") return kernelEnvPackages(req);
  if (req.path === "/daemon/kernel-env/lock") return kernelEnvLock(req);
  return heartbeat(req);
}
