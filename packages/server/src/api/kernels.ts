import {
  LykeionError,
  type KernelEnvStatus,
  type Language,
  type LykeionApi,
  type MachineCompute,
  type RunningKernel,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Actor } from "../auth";
import type { RunCommand, RunRelay } from "../run-relay";
import type { RawKernelReport } from "../kernel-list-registry";
import type { Store } from "../store/store";
import { nextSeq } from "../store/migrations";
import { notebookFor } from "../store/cells";
import { sessionOwner } from "../store/sessions";
import { healthFor } from "../machine-health";

export type KernelsApi = Pick<
  LykeionApi,
  | "listRunningKernels"
  | "computeSnapshot"
  | "taskNotebook"
  | "kernelExecute"
  | "kernelInterrupt"
  | "kernelStop"
  | "kernelRestart"
>;

interface KernelMachine {
  machineId: string;
  ownerId: string;
  name: string;
  lastSeenTs: number;
  /** The identity a `kernel-execute` command needs beyond `kernelId` itself
   *  — everything the kernel host requires that this lab can only recover
   *  from the last cell this kernel reported. */
  sessionId: string;
  taskId: string;
  kernelName: string;
  language: Language;
}

/**
 * The machine holding a kernel, found through the cell it last ran, along
 * with the rest of its identity — `sessionId`, `taskId`, `kernelName` and
 * `language` — the same row already carries. A kernel id is minted by the
 * host from exactly those four and never carries a machine of its own, so
 * the one durable place this lab can learn either is a cell that machine
 * already reported: `cells.session_id` joins to the session's own machine
 * the same way `sessionForTurn` joins a run to one. A kernel that has never
 * finished a cell is answered for by `liveMachineForKernel` instead, which
 * asks the machines rather than this store.
 */
function machineForKernel(store: Store, kernelId: string): KernelMachine | undefined {
  const row = store.get(
    `SELECT r.id AS runtime_id, r.owner_id AS owner_id, r.name AS name, r.last_seen_ts AS last_seen_ts,
            c.session_id AS session_id, c.task_id AS task_id, c.name AS kernel_name, c.language AS language
       FROM cells c
       JOIN sessions s ON s.id = c.session_id
       JOIN runtimes r ON r.id = s.runtime_id
      WHERE c.kernel_id = ?
      ORDER BY c.seq DESC
      LIMIT 1`,
    [kernelId],
  );
  if (!row) return undefined;
  return {
    machineId: row.runtime_id as string,
    ownerId: row.owner_id as string,
    name: row.name as string,
    lastSeenTs: row.last_seen_ts as number,
    sessionId: row.session_id as string,
    taskId: row.task_id as string,
    kernelName: row.kernel_name as string,
    language: row.language as Language,
  };
}

/**
 * The machine holding a kernel, found by asking every machine in the lab what
 * it is holding right now, along with the rest of the kernel's identity.
 *
 * The fallback for a kernel that has no cell of its own. A host mints a
 * kernel's entry when the first cell is addressed to it and before the
 * process behind it is launched, so a kernel whose process could not start,
 * or died inside the cell that started it, is one this lab is told about and
 * has no `cells` row for — which is exactly the kernel a researcher reaches
 * for Restart. Resolving through the live report is what makes the remedy
 * available in the state it exists for.
 *
 * Asked rather than remembered: a machine a kernel was last seen on is a
 * fact that goes stale, and a Restart delivered to the wrong machine is
 * worse than one that has to wait for an answer. This is a researcher's own
 * action on one kernel, so it costs one fan-out and only where the durable
 * record has nothing.
 */
async function liveMachineForKernel(
  deps: Deps,
  kernelId: string,
): Promise<KernelMachine | undefined> {
  const found = (await liveKernels(deps)).find((kernel) => kernel.id === kernelId);
  if (!found) return undefined;
  const row = deps.store.get(
    `SELECT owner_id AS owner_id, name AS name, last_seen_ts AS last_seen_ts
       FROM runtimes WHERE id = ?`,
    [found.machineId],
  );
  if (!row) return undefined;
  return {
    machineId: found.machineId,
    ownerId: row.owner_id as string,
    name: row.name as string,
    lastSeenTs: row.last_seen_ts as number,
    sessionId: found.sessionId,
    taskId: found.taskId,
    kernelName: found.name,
    language: found.language,
  };
}

/**
 * The machine a kernel operation may act on, or the refusal that keeps it
 * off one it should not touch. Shared by every method below that reaches a
 * kernel, so the ownership and health checks a researcher's kernel commands
 * are held to are asked once, in one order, rather than copied three times
 * and left free to drift apart.
 */
async function authorizedKernelMachine(
  deps: Deps,
  actor: Actor,
  now: number,
  kernelId: string,
): Promise<KernelMachine> {
  const resolved =
    machineForKernel(deps.store, kernelId) ?? (await liveMachineForKernel(deps, kernelId));
  if (!resolved)
    throw new LykeionError(
      "unsupported",
      `no machine in this lab is holding a kernel named ${kernelId}`,
    );
  if (resolved.ownerId !== actor.userId)
    throw new LykeionError(
      "forbidden",
      "only the member who paired a machine may run code on its kernels",
    );
  if (healthFor(resolved.lastSeenTs, now) === "offline")
    throw new LykeionError(
      "conflict",
      `${resolved.name} is offline — it has to be running and connected before a cell can run on it`,
    );
  return resolved;
}

/**
 * Delivers a kernel command to its machine's live connection, or refuses.
 * Every kernel command travels this way, never `enqueue`: it addresses one
 * live kernel over one live connection, and a copy left queued for whatever
 * connects next would be replayed against whatever kernel holds that id
 * then — which may not be the kernel a researcher was looking at when they
 * asked for it, including the same daemon's very next process. A machine
 * that is not there to receive a kernel command right now has no kernel to
 * run it, so refusing is the honest answer, not queueing one.
 *
 * Takes only what it actually reads — `machineId` and `name`, for the error
 * message — rather than the full `KernelMachine`, so `environments.ts` can
 * reuse this for `kernel-env-setup`/`kernel-env-reclaim`, which address a
 * machine directly and carry no kernel identity at all.
 */
export function deliverOrRefuse(
  runs: RunRelay,
  machine: { machineId: string; name: string },
  command: RunCommand,
): void {
  if (runs.deliverNow(machine.machineId, command)) return;
  throw new LykeionError(
    "conflict",
    `${machine.name} is not currently connected — reconnect it and try again`,
  );
}

/** How long `listRunningKernels` waits on any one machine's own
 *  `kernel-list` answer. Kept well under the Notebook rail's own 1500ms
 *  poll interval, so a machine that is not answering costs a researcher
 *  watching it at most one visibly slow refresh, never a stuck one. */
const KERNEL_LIST_TIMEOUT_MS = 1200;

const KERNEL_STATES = new Set([
  "lazy",
  "starting",
  "idle",
  "running",
  "stopped",
  "crashed",
  "reclaimed",
]);

/**
 * One raw report from a machine's own `kernel.list`, enriched with the two
 * things its host could never know — which machine this is, carried by the
 * connection this lab reached it over rather than anything the report
 * itself claims, and which Study its session belongs to, read from this
 * lab's own durable record of that session. `undefined` for a report this
 * lab cannot honestly enrich, or that names something a real kernel could
 * not: a language or state this lab does not recognise; a session id
 * naming a session nothing here ever opened; a session that belongs to a
 * *different* machine than the one that just reported holding it — a host
 * only ever holds kernels for sessions opened on its own machine, so this
 * can never happen honestly, only be claimed; or a `taskId` that session
 * has no turn recorded for. That last check is bound to `turns`, not to a
 * Task's own `study_id`: a Task can be re-filed into a different Study
 * after a session opens, and `sessions.study_id` never moves with it, so a
 * live kernel's own Task must still be recognised by the turn that started
 * it, which never changes underneath a later re-filing.
 */
function toRunningKernel(
  store: Store,
  machineId: string,
  raw: RawKernelReport,
): RunningKernel | undefined {
  if (raw.language !== "python" && raw.language !== "r") return undefined;
  if (!KERNEL_STATES.has(raw.state)) return undefined;
  const owner = sessionOwner(store, raw.sessionId);
  if (!owner || owner.machineId !== machineId) return undefined;
  if (!store.get(`SELECT 1 FROM turns WHERE session_id = ? AND task_id = ?`, [raw.sessionId, raw.taskId]))
    return undefined;
  return {
    id: raw.id,
    sessionId: raw.sessionId,
    taskId: raw.taskId,
    name: raw.name,
    language: raw.language,
    machineId,
    studyId: owner.studyId,
    state: raw.state as RunningKernel["state"],
    incarnation: raw.incarnation,
    executionCount: raw.executionCount,
    queueDepth: raw.queueDepth,
    environment: raw.environment,
    ...(raw.startedTs === undefined ? {} : { startedTs: raw.startedTs }),
    ...(raw.lastActivityTs === undefined ? {} : { lastActivityTs: raw.lastActivityTs }),
    ...(raw.reclaimedTs === undefined ? {} : { reclaimedTs: raw.reclaimedTs }),
    ...(raw.processId === undefined ? {} : { processId: raw.processId }),
    ...(raw.stoppedBy === undefined ? {} : { stoppedBy: raw.stoppedBy }),
    ...(raw.stopReason === undefined ? {} : { stopReason: raw.stopReason }),
    ...(raw.restartReason === undefined ? {} : { restartReason: raw.restartReason }),
    ...(raw.resources === undefined ? {} : { resources: raw.resources }),
    ...(raw.series === undefined ? {} : { series: raw.series }),
  };
}

/**
 * What every machine in the lab is holding right now, enriched into the
 * kernels this lab can honestly answer for.
 *
 * Every machine, not only the caller's own — the same lab-wide reach
 * `taskNotebook` gives a Task's cells, and the same reach `listMachines`
 * already gives the machines themselves.
 */
async function liveKernels(deps: Deps): Promise<RunningKernel[]> {
  const { store, runs, kernelLists } = deps;
  const machineIds = store
    .all(`SELECT id FROM runtimes WHERE removed_ts IS NULL`)
    .map((row) => row.id as string);
  const perMachine = await Promise.all(
    machineIds.map(async (machineId): Promise<RunningKernel[]> => {
      const requestId = `klreq_${nextSeq(store)}`;
      // A machine with no live command stream right now is not asked to
      // wait on: nothing is going to answer, and `await` below would
      // just spend its whole timeout finding that out.
      if (!runs.deliverNow(machineId, { type: "kernel-list", runId: requestId })) return [];
      const reports = await kernelLists.await(machineId, requestId, KERNEL_LIST_TIMEOUT_MS);
      const kernels: RunningKernel[] = [];
      for (const raw of reports) {
        const kernel = toRunningKernel(store, machineId, raw);
        if (kernel) kernels.push(kernel);
      }
      return kernels;
    }),
  );
  return perMachine.flat();
}

/**
 * One fan-out, shared by however many callers ask while it is in flight.
 *
 * `listRunningKernels` and `computeSnapshot` are polled together by one
 * render, and each reaches every machine in the lab. Sharing the sweep keeps
 * that at one round of asks and — the part that matters more — makes the
 * machine header arithmetic over the very rows beneath it, so the two cannot
 * disagree.
 *
 * Nothing is retained once it resolves. A cache would need a lifetime nobody
 * can pick: long enough to help is long enough to answer with a reading from
 * before the thing the researcher just did.
 */
let inFlight: Promise<RunningKernel[]> | undefined;

function sweep(deps: Deps): Promise<RunningKernel[]> {
  if (inFlight) return inFlight;
  inFlight = liveKernels(deps).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

export function kernelsApi(deps: Deps): KernelsApi {
  const { store, actor, now, runs, pendingCells } = deps;
  return {
    async listRunningKernels() {
      return sweep(deps);
    },

    async computeSnapshot() {
      const kernels = await sweep(deps);
      const rows = store.all(
        `SELECT id, total_memory_bytes, cores, last_seen_ts, environments FROM runtimes WHERE removed_ts IS NULL`,
      );
      const when = now();
      return rows.map((row): MachineCompute => {
        const machineId = row.id as string;
        const machine: MachineCompute = { machineId };
        // What this machine last reported holding of every environment this
        // lab has declared — read BEFORE the offline return below, unlike
        // every other field here. D2's "the lab's report is the truth about
        // what is built" only holds for an offline machine if that report is
        // remembered rather than re-asked, so this is the one figure an
        // offline machine still gets to say honestly. Absent (not `[]`) on a
        // machine that has never reported it at all.
        if (row.environments !== null)
          machine.environments = JSON.parse(row.environments as string) as KernelEnvStatus[];
        // An offline machine carries nothing else at all — not its counts,
        // and not its own size either. The fan-out reports a machine that did
        // not answer as holding nothing, which is the same shape as a
        // machine that answered "none", and rendering that as "0 kernels"
        // would tell a researcher their colleague's machine is idle when the
        // truth is nobody could reach it. Size goes with the rest, and is why
        // this return comes before it: a row carrying `totalMemoryBytes` and
        // no `memoryBytes` renders "— of 8.0 GB", which reads as a live
        // machine measured at nothing rather than as one nobody could reach.
        // The type says so too — every field but the id and `environments`
        // is optional, and an offline machine carries none of them.
        if (healthFor(row.last_seen_ts as number, when) === "offline") return machine;
        if (row.total_memory_bytes !== null)
          machine.totalMemoryBytes = row.total_memory_bytes as number;
        if (row.cores !== null) machine.cores = row.cores as number;
        const mine = kernels.filter((kernel) => kernel.machineId === machineId);
        machine.kernelCount = mine.length;
        machine.runningCount = mine.filter((k) => k.state === "running").length;
        const measured = mine.filter((k) => k.resources?.memoryBytes !== undefined);
        if (measured.length)
          machine.memoryBytes = measured.reduce(
            (n, k) => n + (k.resources?.memoryBytes ?? 0),
            0,
          );
        const busy = mine.filter((k) => k.resources?.cpuPercent !== undefined);
        if (busy.length)
          machine.cpuPercent = busy.reduce((n, k) => n + (k.resources?.cpuPercent ?? 0), 0);
        // Summed by index, shortest series wins: two kernels started at
        // different moments have rings of different lengths, and aligning
        // them past the shorter one would add a reading to a moment it was
        // not taken in.
        const lengths = mine.map((k) => k.series?.length ?? 0).filter((n) => n > 0);
        if (lengths.length) {
          const span = Math.min(...lengths);
          machine.series = Array.from({ length: span }, (_, i) => {
            // Index from the END of each series: the rings share a clock but
            // not a start, so the newest reading is the aligned one.
            const slot: { memoryBytes?: number; cpuPercent?: number } = {};
            const mem = mine
              .map((k) => k.series?.[k.series.length - span + i]?.memoryBytes)
              .filter((n): n is number => n !== undefined);
            if (mem.length) slot.memoryBytes = mem.reduce((a, b) => a + b, 0);
            const cpu = mine
              .map((k) => k.series?.[k.series.length - span + i]?.cpuPercent)
              .filter((n): n is number => n !== undefined);
            if (cpu.length) slot.cpuPercent = cpu.reduce((a, b) => a + b, 0);
            return slot;
          });
        }
        return machine;
      });
    },

    async taskNotebook(taskId) {
      if (!store.get(`SELECT id FROM tasks WHERE id = ?`, [taskId]))
        throw new LykeionError("not-found", `no such task: ${taskId}`);
      // Any member of the lab, not only whoever filed or is assigned the
      // Task — the same reach `getTask` already gives a cell's own
      // transcript, and a notebook is read the same way that is.
      return notebookFor(store, taskId);
    },

    async kernelExecute(kernelId, code) {
      const resolved = await authorizedKernelMachine(deps, actor, now(), kernelId);
      const cellId = `cell_${nextSeq(store)}`;
      // Held before the command goes out, so the cell that comes back can be
      // recognized as the answer to this ask rather than trusted for saying
      // it is one. What the machine reports about who ran it is not read at
      // all: it is remembered here, where the researcher asking is known.
      pendingCells.mint(resolved.machineId, cellId, actor.userId);
      deliverOrRefuse(runs, resolved, {
        type: "kernel-execute",
        runId: cellId,
        kernelId,
        code,
        cellId,
        sessionId: resolved.sessionId,
        taskId: resolved.taskId,
        name: resolved.kernelName,
        language: resolved.language,
        by: actor.userId,
      });
      return { cellId };
    },

    async kernelInterrupt(kernelId) {
      const resolved = await authorizedKernelMachine(deps, actor, now(), kernelId);
      deliverOrRefuse(runs, resolved, { type: "kernel-interrupt", runId: kernelId, kernelId });
    },

    async kernelStop(kernelId, feedback) {
      const resolved = await authorizedKernelMachine(deps, actor, now(), kernelId);
      deliverOrRefuse(runs, resolved, {
        type: "kernel-stop",
        runId: kernelId,
        kernelId,
        ...(feedback === undefined ? {} : { feedback }),
        by: actor.userId,
      });
    },

    async kernelRestart(kernelId) {
      const resolved = await authorizedKernelMachine(deps, actor, now(), kernelId);
      deliverOrRefuse(runs, resolved, { type: "kernel-restart", runId: kernelId, kernelId });
    },
  };
}
