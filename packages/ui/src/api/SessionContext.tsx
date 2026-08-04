import { createContext, useContext, type ReactNode } from "react";

/**
 * How a signed-in member leaves. Absent in demo mode, where there is no
 * session to end — a control offering to sign you out of nothing is worse
 * than no control at all, so consumers render it only when this is set.
 */
const SessionContext = createContext<(() => void) | undefined>(undefined);

export function SessionProvider({
  signOut,
  children,
}: {
  signOut: () => void;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={signOut}>{children}</SessionContext.Provider>;
}

export function useSignOut(): (() => void) | undefined {
  return useContext(SessionContext);
}
