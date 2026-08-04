import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "../api/ApiContext";
import { hasWorkspaceServer } from "../api/select";
import {
  applyTheme,
  DEFAULT_THEME,
  storedTheme,
  storeTheme,
} from "../lib/themes";

/**
 * Active-theme state, applied to `<html data-theme="...">`, which re-tints
 * every token in tokens.css.
 *
 * A pick is recorded in two places, because they answer different questions.
 * The browser's own record answers immediately and survives a reload, so the
 * first paint is already the right theme rather than the :root default
 * re-tinted a moment later. The lab's record — behind `api.setTheme` — is the
 * account's, and follows the person to another browser.
 *
 * On mount the browser's record wins first because it is the one available
 * synchronously. A real lab's answer then overrides it when it arrives: that
 * record is per-person, and this browser's may be another person's leftovers.
 * With no workspace server behind the page there is nothing to defer to — the
 * in-browser core is rebuilt from seed on every load, so its answer is always
 * the default and adopting it is exactly the bug this avoids.
 */
interface ThemeValue {
  theme: string;
  setTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [theme, setThemeState] = useState(() => storedTheme() ?? DEFAULT_THEME);

  // The single place the document is tinted, so every route into a new theme —
  // this browser's record, the lab's answer, a fresh pick — stamps it the same
  // way. Layout, not effect: it runs before the browser paints, which is what
  // keeps a remembered theme from showing as a flash of the default first.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Ignore failures — whatever is on screen is already a theme this browser
  // chose, so a read error just leaves it standing.
  useEffect(() => {
    if (!hasWorkspaceServer()) return;
    let cancelled = false;
    api
      .getSettings()
      .then((settings) => {
        // An answer carrying no theme is not a choice of the default; it means
        // the lab holds nothing for this person, and their browser's own pick
        // is the better answer.
        if (cancelled || !settings.theme) return;
        setThemeState(settings.theme);
        storeTheme(settings.theme);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setTheme = useCallback(
    (id: string) => {
      // Both records, then the lab. State re-tints on this render; storage is
      // what the next load reads before anything is fetched.
      setThemeState(id);
      storeTheme(id);
      api.setTheme(id).catch(() => {});
    },
    [api],
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme() must be used inside <ThemeProvider>");
  return ctx;
}
