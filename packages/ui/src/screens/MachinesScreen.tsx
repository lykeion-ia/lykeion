import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { MachinesList } from "../components/library/MachinesList";
import { AgentsScreen } from "./setup/AgentsScreen";
import { taskLabeller } from "../components/library/KernelTree";
import { ScreenHeader } from "../components/ui/ScreenHeader";

/**
 * How often this screen re-reads the roster while it stays mounted. Health
 * is derived on read from each machine's last heartbeat, heartbeats arrive
 * every fifteen seconds, and nothing pushes one when it arrives — so this is
 * the only thing that moves a dead machine's row from Online to Offline on a
 * page somebody is already looking at.
 */
const MACHINE_REFRESH_MS = 15_000;

/**
 * How often the kernel tree re-reads. Faster than the roster, because what it
 * shows changes on the scale of a cell rather than of a heartbeat: a kernel
 * goes from idle to running and back inside one turn, and a tree refreshed on
 * the roster's clock would spend most of a session describing a state that
 * had already ended.
 */
const KERNEL_REFRESH_MS = 4_000;

/** Machines (#/machines) — the machines Tasks execute on, what each one is
 *  holding, and the environments those kernels run in. `#/runtimes` still
 *  parses to here: it is in links people already have, and a screen changing
 *  what it calls itself is not a reason to break them. */
export function MachinesScreen() {
  const api = useApi();
  const [tick, setTick] = useState(0);
  const [kernelTick, setKernelTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), MACHINE_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setKernelTick((n) => n + 1), KERNEL_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const q = usePromise(() => api.listMachines(), [api, tick]);
  const me = usePromise(() => api.currentUser(), [api]);
  const kernels = usePromise(() => api.listRunningKernels(), [api, kernelTick]);
  // Read on the same tick `kernels` is: the server shares one fan-out
  // between the two, and polling them on the same clock is what keeps that
  // meaningful — a header and the rows under it built from two different
  // sweeps could disagree with each other on screen.
  const compute = usePromise(() => api.computeSnapshot(), [api, kernelTick]);
  // Names for the tree's middle level, as two calls rather than one per
  // kernel, re-read on the roster's slower clock: a Task's title does not
  // change on the scale a kernel's state does.
  const tasks = usePromise(() => api.listTasks({ includeDone: true }), [api, tick]);
  const studies = usePromise(() => api.listStudies({ includeArchived: true }), [api, tick]);
  // What the lab has declared, on the roster's slower clock: a declaration
  // changes when somebody creates or deletes an environment, which is nothing
  // like the rate a kernel changes state. The rows need it for two things
  // neither of which a machine can answer about itself — whether a machine's
  // copy is a revision behind the lab's current pin, and whether an
  // environment is one a person declared at all, since Lykeion's own starter
  // cannot be deleted.
  const declarations = usePromise(() => api.kernelEnvList(), [api, tick]);

  const machines = q.data ?? [];
  const taskLabel = useMemo(
    () => taskLabeller(tasks.data ?? [], studies.data ?? []),
    [tasks.data, studies.data],
  );

  const onInterrupt = useCallback(
    (kernelId: string) => {
      void api.kernelInterrupt(kernelId).then(() => setKernelTick((n) => n + 1));
    },
    [api],
  );
  const onStop = useCallback(
    (kernelId: string, feedback: string) => {
      // The composer seeds this at `""` and sends it unconditionally on
      // confirm, but an untyped reason is absent, not the empty string — the
      // same "absent is not zero" rule `stopReason`'s own doc comment states.
      // `.trim()` rather than a bare `||`: a reason of only whitespace is
      // still nothing said, by the same rule, and `" "` is truthy.
      void api
        .kernelStop(kernelId, feedback.trim() || undefined)
        .then(() => setKernelTick((n) => n + 1));
    },
    [api],
  );
  const onRestart = useCallback(
    (kernelId: string) => {
      void api.kernelRestart(kernelId).then(() => setKernelTick((n) => n + 1));
    },
    [api],
  );
  // Frees one machine's own copy. Re-reads on the ROSTER's tick, not the
  // kernel tick: what changed is what is on a disk, which is what `compute`
  // carries, and that is polled with the machines.
  const onReclaim = useCallback(
    (machineId: string, name: string) => {
      void api.kernelEnvReclaim(machineId, name).then(() => setTick((n) => n + 1));
    },
    [api],
  );
  // Removes the declaration for the whole lab. The machines' own copies are
  // untouched by this and appear as reclaimable the next time each machine
  // reports — which is the honest behaviour for machines that are offline
  // right now and cannot be told anything.
  const onDelete = useCallback(
    (name: string) => {
      void api.kernelEnvDelete(name).then(() => setTick((n) => n + 1));
    },
    [api],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="Machines" />
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}
      {me.error && <p className="px-5 text-ui text-danger">{me.error}</p>}

      <div className="flex-1 overflow-auto px-5 pb-5 pt-4">
        {/* One list. What is running is not a view beside the roster but a
            fact about a machine on it, so it opens out of that machine's own
            row — the tree that used to sit above named every busy machine a
            second time and left a reader matching the two lists by eye. */}
        <MachinesList
          machines={machines}
          kernels={kernels.data ?? []}
          compute={compute.data ?? []}
          taskLabel={taskLabel}
          now={Date.now() / 1000}
          meId={me.data?.id ?? null}
          onInterrupt={onInterrupt}
          onStop={onStop}
          onRestart={onRestart}
          declarations={declarations.data ?? []}
          onReclaim={onReclaim}
          onDelete={onDelete}
        />

        {/* The same list the first run ends on, for every later visit — this
            is where somebody comes back to when an agent stops working or
            when they finally install one they skipped. Only for machines
            whose `clis` this member may see, which is the ownership rule
            already deciding whether the key is there at all.

            Under the roster, which is the order this page reads in: what the
            lab has, and then what is on each of them. It is also why the
            roster's own CLIs column is gone — this says the same thing in
            full, and said it twice.

            No `onSignIn`: a sign-in opens a browser flow against a vendor and
            writes a credential into a home the daemon owns, and this page is
            served by a lab that may be on another computer entirely. The
            machine's own front door is the only thing that can start one. */}
        {machines
          .filter((machine) => machine.clis !== undefined)
          .map((machine) => (
            <section key={machine.id} className="mb-4 mt-8">
              <h2 className="mb-2 text-ui font-semibold text-fg">
                Agents on {machine.name}
              </h2>
              <AgentsScreen clis={machine.clis ?? []} compact />
            </section>
          ))}
      </div>
    </div>
  );
}

export default MachinesScreen;
