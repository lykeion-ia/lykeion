import { useCallback, useEffect, useState } from "react";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { RuntimesList } from "../components/library/RuntimesList";
import { KernelEnvCard } from "../components/library/KernelEnvCard";
import { KernelTree } from "../components/library/KernelTree";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { SectionTitle } from "../components/settings/SettingsSection";

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

/** Runtimes (#/runtimes) — the machines Tasks execute on, what each one is
 *  holding, and the environments those kernels run in. */
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
  const env = usePromise(() => api.kernelEnvStatus(), [api]);
  const envs = usePromise(() => api.kernelEnvList(), [api]);
  const me = usePromise(() => api.currentUser(), [api]);
  const kernels = usePromise(() => api.listRunningKernels(), [api, kernelTick]);
  // Names for the tree's middle level, as two calls rather than one per
  // kernel, re-read on the roster's slower clock: a Task's title does not
  // change on the scale a kernel's state does.
  const tasks = usePromise(() => api.listTasks({ includeDone: true }), [api, tick]);
  const studies = usePromise(() => api.listStudies({ includeArchived: true }), [api, tick]);

  const runtimes = q.data ?? [];
  const envList = envs.data ?? [];

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
      <ScreenHeader title="Runtimes" />
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}
      {me.error && <p className="px-5 text-ui text-danger">{me.error}</p>}

      <div className="flex-1 overflow-auto px-5 pb-5 pt-4">
        {/* What is running comes first: it is the only part of this screen
            that changes while somebody is looking at it. */}
        <KernelTree
          runtimes={runtimes}
          kernels={kernels.data ?? []}
          tasks={tasks.data ?? []}
          studies={studies.data ?? []}
          now={Date.now() / 1000}
          onInterrupt={onInterrupt}
          onRestart={onRestart}
        />

        <RuntimesList runtimes={runtimes} meId={me.data?.id ?? null} />

        {/* The environments those kernels run in, under the machines because
            an environment is a property of one. The single-status card is the
            fallback for a core that answers `kernelEnvStatus` and has no list
            to give. */}
        {(envList.length > 0 || env.data) && (
          <section className="mb-4">
            <SectionTitle>Environments</SectionTitle>
            {envList.length > 0
              ? envList.map((status) => <KernelEnvCard key={status.name} status={status} />)
              : env.data && <KernelEnvCard status={env.data} />}
          </section>
        )}
      </div>
    </div>
  );
}

export default RuntimesScreen;
