import { timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store";
import type { ChangeRecorder } from "../api/changes";
import {
  isLykeionError,
  type AgentOption,
  type ErrorCode,
  type KernelEnvStatus,
} from "@lykeion/api";
import {
  environmentLockfileFingerprint,
  environmentPackageFingerprint,
  isEnvironmentEvidenceFingerprint,
} from "@lykeion/api/environment-setup-evidence";
import { hashSecret, newToken } from "../auth";
import { nextSeq } from "../store/migrations";
import { environmentStore } from "../store/environments";
import { declareEnvironment, planFor } from "../api/environments";
import type { RunRelay } from "../run-relay";
import {
  kernelEnvironmentStatusAnswers,
  type EnvironmentSetupCoordinator,
} from "../environment-setup-coordinator";
import { environmentSetupStore } from "../store/environment-setups";

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
  /** Durable setup attempts: the lifecycle every `kernel-env-setup` ask on
   *  this wire is classified against before it is settled or authorized. */
  coordinator: EnvironmentSetupCoordinator;
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
  "POST /daemon/kernel-env/require",
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

export function isKernelEnvStatus(value: unknown): value is KernelEnvStatus {
  if (value === null || typeof value !== "object") return false;
  const status = value as Record<string, unknown>;
  return (
    (status.state === "absent" || status.state === "ready" || status.state === "broken") &&
    typeof status.name === "string" && status.name.length > 0 &&
    (status.language === "python" || status.language === "r") &&
    (status.manager === "uv" || status.manager === "conda") &&
    typeof status.platform === "string" && status.platform.length > 0 &&
    typeof status.root === "string" && status.root.length > 0 &&
    (status.version === undefined || typeof status.version === "string") &&
    (status.packageCount === undefined ||
      (typeof status.packageCount === "number" && Number.isInteger(status.packageCount) && status.packageCount >= 0)) &&
    (status.lockRevision === undefined ||
      (typeof status.lockRevision === "number" && Number.isInteger(status.lockRevision) && status.lockRevision >= 0)) &&
    (status.setupRequestId === undefined ||
      (typeof status.setupRequestId === "string" && status.setupRequestId.length > 0)) &&
    (status.lockfileFingerprint === undefined ||
      isEnvironmentEvidenceFingerprint(status.lockfileFingerprint)) &&
    (status.packageFingerprint === undefined ||
      isEnvironmentEvidenceFingerprint(status.packageFingerprint)) &&
    (status.declarationGenerationId === undefined ||
      (typeof status.declarationGenerationId === "string" &&
        status.declarationGenerationId.length > 0)) &&
    (status.declarationCreatedTs === undefined ||
      (typeof status.declarationCreatedTs === "number" &&
        Number.isInteger(status.declarationCreatedTs) && status.declarationCreatedTs >= 0))
  );
}

function environmentStatusesField(body: unknown): KernelEnvStatus[] | undefined {
  const value = arrayField(body, "environments");
  return value === undefined ? undefined : value.filter(isKernelEnvStatus);
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
 * Which of the Researches and Tasks a machine holds a working directory for
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
  // `studyIds`, not `researchIds`: the daemon sends and reads this payload
  // under the old name, and it names the on-disk workspaces it is asking
  // about. Same boundary as `RunCommand.studyId`.
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
  const environmentStatuses = environmentStatusesField(body);

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

  // After the report transaction commits: a ready transition is its own
  // durable write and must never observe a machine status that the runtime
  // row then rolls back. An absent field is not an empty report and causes
  // no transition inside the coordinator.
  req.coordinator.reconcileMachine(machine.machineId, environmentStatuses, req.changes.record);

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

/** Records one exact source turn as waiting for one declared, unbuilt
 * environment. This route creates no physical job: setup remains an explicit
 * Machines/Notebook-surface action. */
function kernelEnvRequire(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  const runId = field(req.body, "runId");
  const sessionId = field(req.body, "sessionId");
  const environmentName = field(req.body, "environmentName");
  if (!runId || !sessionId || !environmentName)
    return {
      status: 400,
      json: { error: "a runId, sessionId and environmentName are required" },
    };

  const source = req.store.get(
    `SELECT t.id, t.task_id, t.session_id, t.origin, t.ended_ts,
            s.study_id AS session_study_id, s.runtime_id,
            s.ended_ts AS session_ended_ts, k.study_id AS task_study_id
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       JOIN tasks k ON k.id = t.task_id
      WHERE t.id = ?`,
    [runId],
  );
  if (
    !source ||
    source.ended_ts !== null ||
    source.session_ended_ts !== null ||
    source.origin !== "user" ||
    source.session_id !== sessionId ||
    source.runtime_id !== machine.machineId ||
    source.session_study_id !== source.task_study_id
  ) return {
    status: 403,
    json: { error: "this machine does not hold that exact live source turn" },
  };
  const newest = req.store.get(
    `SELECT id FROM turns WHERE task_id = ? AND origin = 'user' ORDER BY seq DESC LIMIT 1`,
    [source.task_id],
  );
  if (newest?.id !== runId)
    return {
      status: 409,
      json: { error: "that source is not the newest researcher turn for this Task" },
    };
  const declaration = environmentStore(req.store).get(environmentName);
  if (!declaration)
    return { status: 404, json: { error: `no such environment: ${environmentName}` } };

  const reported = req.store.get(`SELECT environments FROM runtimes WHERE id = ?`, [machine.machineId]);
  let statuses: KernelEnvStatus[] = [];
  if (typeof reported?.environments === "string") {
    try {
      const value = JSON.parse(reported.environments as string) as unknown;
      if (Array.isArray(value)) statuses = value.filter(isKernelEnvStatus);
    } catch {
      // Malformed is unknown, never evidence that the environment is ready.
    }
  }
  const currentLock = environmentStore(req.store).readLock(
    declaration.name,
    declaration.lockRevision,
  );
  if (
    declaration.declarationGenerationId !== undefined &&
    currentLock !== undefined &&
    statuses.some((status) =>
      kernelEnvironmentStatusAnswers(
        {
          environmentName: declaration.name,
          language: declaration.language,
          manager: declaration.manager,
          lockRevision: declaration.lockRevision,
          declarationGenerationId: declaration.declarationGenerationId!,
          lockfileFingerprint: environmentLockfileFingerprint(currentLock),
          packageFingerprint: environmentPackageFingerprint(declaration.packages),
        },
        status,
      ),
    )
  )
    return {
      status: 409,
      json: { error: `${environmentName} is already ready on this machine` },
    };

  const result = req.coordinator.attachWaiter(
    {
      studyId: source.task_study_id as string,
      taskId: source.task_id as string,
      sessionId,
      sourceTurnId: runId,
      sourceRunId: runId,
      language: declaration.language,
      environmentName,
      runtimeId: machine.machineId,
      createdTs: req.now,
    },
    req.changes.record,
  );
  return { status: 200, json: result };
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

/**
 * The Task this session belongs to, or `undefined` for a session holding no
 * turns at all.
 *
 * `sessions` names a Research and never a Task; `turns` is where the two meet.
 * Read from the session's newest turn and NOT restricted to a live one, which
 * is a lookup rather than a guess: a session serves exactly one Task by
 * construction. `liveSessionFor` and `activeTurnForTask`
 * (`store/sessions.ts`) both find a session by the Task it already holds turns
 * for, so a session is only ever reused for that same Task, and its newest
 * turn names it whether or not that turn has ended.
 *
 * Restricting this to a LIVE turn is the tempting version and it is wrong.
 * `manage_packages` is answered on a card, and the turn can end between the
 * researcher answering it and this call landing — a narrow race, but one that
 * would then file no interest, and an add with no interest is one
 * `uncoveredInterests` cannot carry onto another round when the build it
 * joined settles without its packages. Nothing surfaces that: the bar reads
 * "Ready" off the machine's status, `KernelEnvCard`'s "a revision behind"
 * badge compares lock revisions a joined build leaves equal, and no passive
 * surface compares the declaration's packages against what was built. The
 * researcher would be told their packages were added, and they would be
 * declared, and no machine would hold them.
 */
function taskOfSession(store: Store, sessionId: string): string | undefined {
  const row = store.get(
    `SELECT task_id FROM turns
      WHERE session_id = ?
      ORDER BY seq DESC LIMIT 1`,
    [sessionId],
  );
  return row === undefined ? undefined : (row.task_id as string);
}

const NOT_THIS_MACHINES_SESSION = {
  status: 403,
  json: { error: "this machine is not running a session with that id" },
};

/**
 * How far the card behind this call was answered, or `undefined` for an
 * answer this route will not take.
 *
 * Two scopes, and only two: an environment card offers `once` and
 * `conversation` and nothing wider, because a grant "across all projects" to
 * change what is installed on every machine in this lab is a permanent,
 * unasked licence to run other people's build scripts on colleagues'
 * computers. The daemon refuses `study` and `global` in front of the
 * researcher; this refuses them again, because this route is reachable from
 * anything holding a machine token and what it does is WRITE.
 *
 * Refused rather than narrowed. A caller told "for this Study" and given one
 * call would believe the wrong thing, and the change itself would be written
 * either way — so the whole call is turned away and nothing happens at all.
 *
 * ABSENT is `once`, and absent is the only thing that is: a daemon older than
 * this field still changes environments for researchers who allowed it, and
 * reading its silence as a standing grant would mint authority nobody was
 * asked for. Anything else — a scope this lab does not have, a number, null —
 * is a caller to refuse, not a caller to guess at.
 */
function answeredScope(body: unknown): "once" | "conversation" | undefined {
  const value = (body as Record<string, unknown> | null)?.permissionScope;
  if (value === undefined) return "once";
  return value === "once" || value === "conversation" ? value : undefined;
}

const SCOPE_THIS_ROUTE_WILL_NOT_TAKE = {
  status: 400,
  json: {
    error:
      "an environment change is remembered for one call or for this conversation, and for nothing wider",
  },
};

function kernelEnvCreate(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  const sessionId = field(req.body, "sessionId");
  const name = field(req.body, "name");
  const packages = arrayField(req.body, "packages");
  // Read by hand rather than through `optionalStringField`, and the
  // difference is the guard: that helper answers `undefined` for anything
  // that is not a string, so `language: 7` and `language: null` would arrive
  // here indistinguishable from absent and be quietly built as Python. This
  // has to tell "not sent" from "sent wrong" — the first is a daemon older
  // than the field, the second is a caller to refuse.
  //
  // ABSENT is python, and absent is the only thing that is. A daemon old
  // enough to predate this field still declares the Python environments it
  // always did; anything else it sends — including a language this lab has
  // no provisioner for — is refused rather than coerced, because the
  // manager is DERIVED from this word and a wrong one builds the wrong kind
  // of thing under the right name.
  const language = req.body === null || typeof req.body !== "object" ||
    (req.body as Record<string, unknown>).language === undefined
    ? "python"
    : (req.body as Record<string, unknown>).language;
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
  if (language !== "python" && language !== "r")
    return {
      status: 400,
      json: { error: `an environment is for python or r, and ${JSON.stringify(language)} is neither` },
    };
  const scope = answeredScope(req.body);
  if (scope === undefined) return SCOPE_THIS_ROUTE_WILL_NOT_TAKE;
  const session = researcherOfSession(req.store, machine, sessionId);
  if (!session) return NOT_THIS_MACHINES_SESSION;
  try {
    // One transaction for the declaration and the standing permission over
    // it. A create this lab refuses — the name is taken, most often by a
    // colleague's environment — must leave nothing behind: minted anyway, the
    // conversation would hold uncarded authority to install software into
    // something the researcher was never shown, off a card for an environment
    // that does not exist. `declareEnvironment` opens its own transaction and
    // this nests inside it, so its refusal takes the grant with it.
    const declaration = req.store.tx(() => {
      const declared = declareEnvironment(
        req.store,
        (kind, payload, ownerId) => req.changes.record(kind, payload, ownerId),
        // The language the daemon was asked for, not a constant. This wire
        // carried none while the provisioner built Python environments alone;
        // it carries one now, and `declareEnvironment` derives the package
        // manager from it (`python` → uv, `r` → conda) so that deriving it is
        // done once, here, for every caller.
        { name, language, packages },
        session.openedBy,
        req.now,
      );
      // Under the session's own researcher, the same way the declaration is:
      // a grant is one person's answer, and the token names only a machine.
      if (scope === "conversation")
        environmentSetupStore(req.store).rememberEnvironmentGrant(
          sessionId,
          declared.name,
          session.openedBy,
          req.now,
        );
      return declared;
    });
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
 * broken store, and the Setup surface already refuses it by name in front of
 * a researcher who can act on it.
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
 *
 * **Coalesce, then re-check.** The coordinator owns the one physical job per
 * machine and environment, so an add landing while a build is already running
 * joins that build rather than starting a second `uv venv --clear` over the
 * same directory. Joining it is not the same as being satisfied by it: the
 * build was planned from the declaration as it read when it STARTED, and this
 * caller arrived afterwards having just appended to it. What closes that gap
 * is the Task INTEREST this route files with the ask — when the joined build
 * settles, `uncoveredInterests` compares what it actually covered against what
 * each interest asked for and carries the ones it missed onto another round,
 * to a fourth. Without that, the second of two adds is answered `building:
 * true`, is never built on any machine, and every kernel in the environment
 * restarts announcing only the first one.
 *
 * The same follow-up catches the other direction: an add landing while a Setup
 * click is REPLAYING the old pin joins that replay, which resolves nothing —
 * the interest is uncovered, and the round it earns resolves.
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
  const scope = answeredScope(req.body);
  if (scope === undefined) return SCOPE_THIS_ROUTE_WILL_NOT_TAKE;
  const session = researcherOfSession(req.store, machine, sessionId);
  if (!session) return NOT_THIS_MACHINES_SESSION;
  // Which Task this add belongs to. Only the rebuild below uses it, and only
  // to file this Task's interest in the build; the declaration and the grant
  // are the researcher's answer and are written either way.
  const taskId = taskOfSession(req.store, sessionId);
  const envs = environmentStore(req.store);
  const declaration = envs.get(name);
  // 404 rather than a create in disguise. `manage_packages` adds to what
  // exists; a name this lab does not declare is a different request, asked
  // on a different card, and answering it here would install software under
  // a question the researcher was never shown.
  if (declaration === undefined)
    return { status: 404, json: { error: `this lab declares no environment named ${name}` } };

  // The append and the standing permission over the name, together — the same
  // rule the create keeps: an add this lab would not make leaves no grant
  // behind it. `added: []` is not that case; it is everything asked for
  // already being declared, which is the state the researcher asked for,
  // already reached, and the answer they gave still stands over the name.
  const { packages: held, added } = req.store.tx(() => {
    const appended = envs.addPackages(name, packages);
    if (scope === "conversation")
      environmentSetupStore(req.store).rememberEnvironmentGrant(
        sessionId,
        name,
        session.openedBy,
        req.now,
      );
    return appended;
  });
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
  // Asked for, never waited on — see the note above. A failure to ask is
  // swallowed rather than reported: this call has already written the
  // declaration every machine in the lab builds from, and a machine that
  // cannot be reached down its own command stream right now is a machine
  // whose researcher will click Setup, or whose next session will find the
  // environment missing and say so by name.
  let asked: { jobId: string } | undefined;
  try {
    asked = req.coordinator.requestRebuild(
      {
        machineId: machine.machineId,
        environmentName: name,
        // What THIS call is owed — the declaration its own append just
        // produced. A build already in flight was planned before these
        // packages existed, so joining it is not the same as being satisfied
        // by it. Recorded as this Task's interest so that when the build it
        // joined settles without them, `uncoveredInterests` carries the Task
        // onto another round rather than leaving the packages declared and
        // built nowhere.
        requestedPackages: held,
        requestedBy: session.openedBy,
        ...(taskId === undefined ? {} : { taskId }),
        reason,
      },
      req.changes.record,
    );
  } catch {
    // Same swallow as before, in the shape this ask now has: it is
    // synchronous, so the refusal arrives here rather than as a rejection.
    // The declaration this call already wrote stands either way.
  }
  // `building` says what happened, not what was attempted. `requestRebuild`
  // answers `undefined` where no build could be asked for — a declaration
  // deleted underneath this call, or a pinned revision whose text this lab
  // does not hold — and a throw leaves it unset. Telling the agent a build is
  // running in either case is how it comes to import something that is not
  // there and never will be.
  if (asked === undefined)
    return {
      status: 200,
      json: { declaration: { ...declaration, packages: held }, added, building: false },
    };
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
 * lab's own lockfile and asked to materialize it, and the job records that by
 * carrying no `resolvedFrom`. Accepted anyway, its text would become a
 * revision this lab cannot say what was resolved from — which is precisely
 * the state `planFor` answers by widening every other machine to `resolve`.
 * One materialize-only machine would turn D4 off lab-wide for that
 * environment, durably, and every colleague would re-resolve independently
 * from then on. `bindResolvedLock` is what refuses it, on the job's own
 * `resolved_from` rather than on anything the machine says.
 */
function kernelEnvLock(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  const requestId = field(req.body, "requestId");
  const name = field(req.body, "name");
  const lockfile = field(req.body, "lockfile");
  const declarationGenerationId = field(req.body, "declarationGenerationId");
  if (!requestId || !name || !lockfile)
    return { status: 400, json: { error: "a requestId, a name and a lockfile are required" } };
  // A request id this lab holds no setup job for was asked for nothing, and a
  // pin is the one thing on this wire every other machine replays verbatim.
  const durable = environmentSetupStore(req.store).jobByRequest(requestId);
  if (!durable)
    return { status: 403, json: { error: "this machine was not asked to resolve that environment" } };
  if (!declarationGenerationId)
    return {
      status: 400,
      json: { error: "a durable environment lock requires its declarationGenerationId" },
    };
  const lockRevision = req.coordinator.bindResolvedLock(
    machine.machineId,
    requestId,
    name,
    declarationGenerationId,
    lockfile,
    req.changes.record,
  );
  if (lockRevision === undefined)
    return { status: 403, json: { error: "this machine was not asked to resolve that environment" } };
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
  if (req.path === "/daemon/kernel-env/require") return kernelEnvRequire(req);
  if (req.path === "/daemon/kernel-env/create") return kernelEnvCreate(req);
  if (req.path === "/daemon/kernel-env/packages") return kernelEnvPackages(req);
  if (req.path === "/daemon/kernel-env/lock") return kernelEnvLock(req);
  return heartbeat(req);
}
