import { useEffect } from "react";
import type { Transport } from "@lykeion/api";
import { useInvalidateData } from "../api/ApiContext";

/**
 * Turns a remote change into the same signal a local write already sends.
 * Screens do not subscribe to anything: they already re-read when the data
 * version moves, so a colleague's edit and your own reach them by one path.
 *
 * `transport` is `undefined` in demo mode, where there is no server to
 * subscribe to — the effect below does nothing at all in that case, not
 * even open a connection that would have nowhere real to point.
 */
export function useChangeChannel(transport: Transport | undefined): void {
  const invalidate = useInvalidateData();

  useEffect(() => {
    if (!transport) return;
    // Opened with no cursor, in both the cases that reach here. A dropped
    // connection is the browser's to resume, and it does, replaying its own
    // last event id — holding a second copy of the position here would only
    // give the two something to disagree about. Anything else that reruns
    // this effect is the whole data layer being rebuilt for a different
    // member, which re-reads everything regardless of what a cursor said.
    const close = transport.openEvents(
      undefined,
      () => invalidate(),
      () => invalidate(),
    );
    return close;
  }, [transport, invalidate]);
}
