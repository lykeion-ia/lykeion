import { useEffect, useState } from "react";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { RuntimesList } from "../components/library/RuntimesList";
import { KernelEnvCard } from "../components/library/KernelEnvCard";
import { ScreenHeader } from "../components/ui/ScreenHeader";

/**
 * How often this screen re-reads the roster while it stays mounted. Health
 * is derived on read from each machine's last heartbeat, heartbeats arrive
 * every fifteen seconds, and nothing pushes one when it arrives — so this is
 * the only thing that moves a dead machine's row from Online to Offline on a
 * page somebody is already looking at.
 */
const RUNTIME_REFRESH_MS = 15_000;

/** Runtimes (#/runtimes) — the machines/environments tasks execute in. */
export function RuntimesScreen() {
  const api = useApi();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), RUNTIME_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  const q = usePromise(() => api.listRuntimes(), [api, tick]);
  const env = usePromise(() => api.kernelEnvStatus(), [api]);
  const me = usePromise(() => api.currentUser(), [api]);
  const runtimes = q.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="Runtimes" />
      {q.error && <p className="px-5 text-[13px] text-danger">{q.error}</p>}
      {me.error && <p className="px-5 text-[13px] text-danger">{me.error}</p>}
      {env.data && (
        <div className="px-5 pt-4">
          <KernelEnvCard status={env.data} />
        </div>
      )}
      <RuntimesList runtimes={runtimes} meId={me.data?.id ?? null} />
    </div>
  );
}

export default RuntimesScreen;
