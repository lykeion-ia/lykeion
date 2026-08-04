import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LykeionApi } from "@lykeion/api";
import {
  directoryOf,
  pendingDirectory,
  type Directory,
} from "../lib/assignee";

/**
 * The one seam between the UI and its data layer. Every component talks to a
 * `LykeionApi` obtained via `useApi()`, which is what keeps the surface
 * independent of its data source and trivially testable.
 */
const ApiContext = createContext<LykeionApi | null>(null);

/**
 * The member directory, fetched once here rather than per consumer — a
 * board of task cards would otherwise fire one `listMembers()` call per
 * card. `useDirectory()` (in `hooks/useDirectory.ts`) is the read side.
 *
 * `null` means "no `<ApiProvider>` above this point" — it is never the value
 * an actual provider hands down, so `useDirectory()` can tell a missing
 * provider apart from one that is still loading.
 */
export const DirectoryContext = createContext<Directory | null>(null);

/**
 * The one cross-screen invalidation signal: a write happened somewhere in the
 * app, and any surface whose data could have changed should read again. A
 * screen too far from the write to be told directly (the Rail's global New
 * task button, for instance, has no idea a Studies row exists) still shares
 * this, because every screen sits under the same `<ApiProvider>`.
 *
 * `version` is a dependency-list value: put it where a `nonce` used to go.
 * `invalidate` is the write side, referentially stable so it is safe to close
 * over in a `useEffect`/`useCallback` dependency list.
 */
interface DataVersion {
  version: number;
  invalidate: () => void;
}
const DataVersionContext = createContext<DataVersion | null>(null);

export function ApiProvider({
  api,
  children,
}: {
  api: LykeionApi;
  children: ReactNode;
}) {
  const [directory, setDirectory] = useState<Directory>(pendingDirectory());
  const [version, setVersion] = useState(0);
  // Empty deps: identity must survive every render, or a consumer that closes
  // over it in an effect dependency list would re-fire on every render.
  const invalidate = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);
  const dataVersion = useMemo<DataVersion>(
    () => ({ version, invalidate }),
    [version, invalidate],
  );

  // Re-read on every change, the same way every screen does. A directory
  // fetched once and kept is the one place a colleague who joined after
  // this tab loaded stays invisible — unassignable in every picker, and an
  // unknown id wherever they are already named — and a colleague who left
  // goes on being offered.
  useEffect(() => {
    let cancelled = false;
    api.listMembers().then(
      (members) => {
        if (!cancelled) setDirectory(directoryOf(members));
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error(
          "[ApiProvider] failed to load the member directory:",
          err,
        );
        // Settle to loaded-but-empty rather than leaving every lookup
        // pending forever: a chip should read "Unknown member", not stay
        // blank for the rest of the session.
        setDirectory(directoryOf([]));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, version]);

  return (
    <ApiContext.Provider value={api}>
      <DirectoryContext.Provider value={directory}>
        <DataVersionContext.Provider value={dataVersion}>
          {children}
        </DataVersionContext.Provider>
      </DirectoryContext.Provider>
    </ApiContext.Provider>
  );
}

export function useApi(): LykeionApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi() must be used inside <ApiProvider>");
  return api;
}

/**
 * The data version, or `0` where there is no provider — a component rendered
 * on its own in a test, which has no lab behind it to change. `usePromise`
 * reads it this way so that folding the version into every read cannot turn
 * a bare render into a thrown error.
 */
export function useDataVersionIfAny(): number {
  return useContext(DataVersionContext)?.version ?? 0;
}

/** Put in a `usePromise` dependency list to refetch whenever a write anywhere
 *  in the app might have changed the data being read. */
export function useDataVersion(): number {
  const ctx = useContext(DataVersionContext);
  if (!ctx)
    throw new Error("useDataVersion() must be used inside <ApiProvider>");
  return ctx.version;
}

/** Call after a write whose result another surface might already be
 *  showing. Referentially stable — safe in an effect's dependency list. */
export function useInvalidateData(): () => void {
  const ctx = useContext(DataVersionContext);
  if (!ctx)
    throw new Error("useInvalidateData() must be used inside <ApiProvider>");
  return ctx.invalidate;
}
