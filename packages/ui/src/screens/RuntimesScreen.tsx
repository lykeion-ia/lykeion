import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { RuntimesList } from "../components/library/RuntimesList";
import { taskLabeller } from "../components/library/KernelTree";
import { ScreenHeader } from "../components/ui/ScreenHeader";

/**
 * How often this screen re-reads the roster while it stays mounted. Health
 * is derived on read from each machine's last heartbeat, heartbeats arrive
 * every fifteen seconds, and nothing pushes one when it arrives — so this is
 * the only thing that moves a dead machine's row from Online to Offline on a
 * page somebody is already looking at.
 */
const RUNTIME_REFRESH_MS = 15_000;

/**
 * How often the kernel tree re-reads. Faster than the roster, because what it
 * shows changes on the scale of a cell rather than of a heartbeat: a kernel
 * goes from idle to running and back inside one turn, and a tree refreshed on
 * the roster's clock would spend most of a session describing a state that
 * had already ended.
 */
const KERNEL_REFRESH_MS = 4_000;

/** Machines (#/runtimes) — the machines Tasks execute on, what each one is
 *  holding, and the environments those kernels run in. The route keeps the
 *  old word: it is in links people already have, and what a screen calls
 *  itself is not a reason to break them. */
export function RuntimesScreen() {
  const api = useApi();
  const [tick, setTick] = useState(0);
  const [kernelTick, setKernelTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), RUNTIME_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setKernelTick((n) => n + 1), KERNEL_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const q = usePromise(() => api.listRuntimes(), [api, tick]);
  const me = usePromise(() => api.currentUser(), [api]);
  const kernels = usePromise(() => api.listRunningKernels(), [api, kernelTick]);
  // Names for the tree's middle level, as two calls rather than one per
  // kernel, re-read on the roster's slower clock: a Task's title does not
  // change on the scale a kernel's state does.
  const tasks = usePromise(() => api.listTasks({ includeDone: true }), [api, tick]);
  const studies = usePromise(() => api.listStudies({ includeArchived: true }), [api, tick]);

  const runtimes = q.data ?? [];
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
  const onRestart = useCallback(
    (kernelId: string) => {
      void api.kernelRestart(kernelId).then(() => setKernelTick((n) => n + 1));
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
        <RuntimesList
          runtimes={runtimes}
          kernels={kernels.data ?? []}
          taskLabel={taskLabel}
          now={Date.now() / 1000}
          meId={me.data?.id ?? null}
          onInterrupt={onInterrupt}
          onRestart={onRestart}
        />
      </div>
    </div>
  );
}

export default RuntimesScreen;
