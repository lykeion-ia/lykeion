import { timingSafeEqual } from "node:crypto";
import type { Store } from "../store/store";
import type { ChangeRecorder } from "../api/changes";
import type { AgentOption } from "@lykeion/api";
import { hashSecret, newToken } from "../auth";
import { nextSeq } from "../store/migrations";

/** The machine a bearer token names. */
export interface Machine {
  runtimeId: string;
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
}

export interface DaemonResult {
  status: number;
  json: unknown;
}

const BEARER_PREFIX = "Bearer ";

/**
 * The machine a bearer token names, or undefined. Mirrors `resolveActor` in
 * what it refuses: a revoked token is not a machine, neither is one whose
 * runtime has since been removed, and neither is one whose owner has since
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
  return { runtimeId: row.runtime_id as string, ownerId: row.owner_id as string };
}

const OWNED_ROUTES = new Set([
  "POST /daemon/pair/exchange",
  "POST /daemon/heartbeat",
  "POST /daemon/report",
  "POST /daemon/workspaces",
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

/** One CLI as a report's body carries it — the same shape as `AgentCli`,
 *  minus the `runtimeId` a report has no reason to name itself. `sessionReady`
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
    const runtimeId = `rt_${seq}`;
    store.run(
      `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runtimeId,
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
      [hashSecret(token), runtimeId, request.owner_id, now, nextSeq(store)],
    );
    changes.record("runtime-paired", {}, request.owner_id as string);
    const lab = store.get(`SELECT org_name FROM lab_settings WHERE id = 1`);
    success = {
      token,
      runtimeId,
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
function touchLastSeen(store: Store, runtimeId: string, ts: number): void {
  store.run(`UPDATE runtimes SET last_seen_ts = ? WHERE id = ?`, [ts, runtimeId]);
}

function heartbeat(req: DaemonRequest): DaemonResult {
  const machine = resolveMachine(req.store, req.authorization);
  if (!machine) return { status: 401, json: { error: "no such machine" } };
  touchLastSeen(req.store, machine.runtimeId, req.now);
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
 * only when something an owner would actually see on the Runtimes screen is
 * different from what is already stored: the reported platform, daemon
 * version, or capabilities, or the CLI set compared on `(cli_id, version,
 * available, sessionReady)`. Never more than one entry, whatever combination
 * of those changed.
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

  store.tx(() => {
    const current = store.get(`SELECT platform, daemon_version, capabilities FROM runtimes WHERE id = ?`, [
      machine.runtimeId,
    ])!;
    const existing = store
      .all(
        `SELECT cli_id, version, available, session_ready, options,
                signed_in, account, held_back_reason, adapter_provenance
           FROM runtime_clis WHERE runtime_id = ?`,
        [machine.runtimeId],
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
      current.capabilities !== capabilitiesJson;
    // Read once, before the delete below takes the rows this reads from out.
    const optionsFor = optionsKeeper(existing);
    const changed = metaChanged || cliSetChanged(existing, clis, optionsFor);

    store.run(
      `UPDATE runtimes SET platform = ?, daemon_version = ?, capabilities = ?, last_seen_ts = ? WHERE id = ?`,
      [platform, daemonVersion, capabilitiesJson, req.now, machine.runtimeId],
    );
    store.run(`DELETE FROM runtime_clis WHERE runtime_id = ?`, [machine.runtimeId]);
    for (const cli of clis) {
      store.run(
        `INSERT INTO runtime_clis
           (runtime_id, cli_id, name, command, version, available, session_ready,
            session_ready_reason, options, signed_in, account, held_back_reason,
            adapter_provenance, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          machine.runtimeId,
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
  return heartbeat(req);
}
