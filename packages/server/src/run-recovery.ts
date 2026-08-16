import type { RunEventFrame } from "@lykeion/api";
import type { RunRelay } from "./run-relay";
import type { Store } from "./store/store";
import { recordRunFrames, runSnapshot } from "./store/sessions";

/**
 * Ends every run in `dropped` the same way a genuine `completed` frame from
 * the daemon that held it would: durable in `turns` first — through
 * `recordRunFrames`, the same function `/daemon/run/events` itself writes a
 * real ending with — then fanned out through `publish`, the one code path
 * that also retires the run's own commands from its machine's queue and
 * makes its buffer eligible to age out. No parallel copy of either half
 * exists here.
 *
 * `reason` names the machine, read off `machines` — a status flip with no
 * explanation is a shrug; a researcher reading this on a run's own stream
 * needs to know it was the machine reconnecting without this run, not a
 * fault this run's own turn found.
 */
export function failDroppedRuns(
  store: Store,
  runs: RunRelay,
  machineId: string,
  dropped: string[],
  nowTs: number,
): void {
  if (dropped.length === 0) return;
  const machineName = store.get(`SELECT name FROM runtimes WHERE id = ?`, [machineId])?.name as
    | string
    | undefined;
  const reason =
    `${machineName ?? "this machine"} reconnected without this run — treated as failed ` +
    `rather than left running forever`;
  for (const runId of dropped) {
    const durableNext = (runSnapshot(store, runId)?.lastEventSeq ?? 0) + 1;
    const frames: RunEventFrame[] = [
      {
        seq: Math.max(durableNext, runs.nextSeqFor(runId)),
        event: { event: "completed", state: { state: "failed", reason } },
      },
    ];
    const accepted = store.tx(() => recordRunFrames(store, runId, frames, nowTs));
    runs.publish(runId, accepted);
  }
}
