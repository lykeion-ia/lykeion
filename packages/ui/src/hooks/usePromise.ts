import { useEffect, useState, type DependencyList } from "react";
import { useDataVersionIfAny } from "../api/ApiContext";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Run an async producer and expose its lifecycle. Cancels stale settlements
 * when deps change or the component unmounts.
 *
 * Every read re-runs when the lab's data version moves — a write on this
 * screen, a write on another, or a colleague's edit arriving on the change
 * channel. Folded in here rather than left to each caller's dependency list
 * because a caller that forgets shows stale data with nothing failing:
 * the screen renders, the test passes, and only a second browser open on
 * the same page ever reveals it.
 */
export function usePromise<T>(
  fn: () => Promise<T>,
  deps: DependencyList,
): AsyncState<T> {
  const version = useDataVersionIfAny();
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    // What is on screen stays on screen while the next answer is fetched.
    // Clearing it first blanks every open page for a round trip every time
    // anybody in the lab changes anything, and then repaints the same
    // content — which reads as a flicker on every colleague's keystroke.
    setState((previous) => ({ ...previous, loading: true }));
    fn().then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (err: unknown) => {
        if (!cancelled)
          setState({
            data: null,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          });
      },
    );
    return () => {
      cancelled = true;
    };
    // The caller owns its own dependency list, like useEffect itself; the
    // version is this hook's own and is always in it.
  }, [...deps, version]);

  return state;
}
