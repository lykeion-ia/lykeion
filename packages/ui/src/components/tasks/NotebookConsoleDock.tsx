import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { Language, RunningKernel } from "@lykeion/api";
import { useOutsideClick } from "../../hooks/useOutsideClick";
import { contextLabel, languageLabel } from "./notebook-model";

export const CONSOLE_MIN_PX = 96;
export const CONSOLE_MAX_PX = 320;
export const CONSOLE_STEP_PX = 16;
export const CONSOLE_LARGE_STEP_PX = 64;

function clampConsoleHeight(height: number): number {
  return Math.min(CONSOLE_MAX_PX, Math.max(CONSOLE_MIN_PX, height));
}

export function NotebookConsoleDock({
  kernel,
  language,
  contextName,
  code,
  busy,
  error,
  onCodeChange,
  onRun,
  onInterrupt,
  onRestart,
}: {
  kernel: RunningKernel | undefined;
  language: Language | null;
  contextName: string | null;
  code: string;
  busy: boolean;
  error: string | null;
  onCodeChange(code: string): void;
  onRun(): void;
  onInterrupt(): void;
  onRestart(): void;
}): React.JSX.Element {
  const [height, setHeight] = useState(128);
  const dockRef = useRef<HTMLDivElement>(null);
  const removePointerListeners = useRef<(() => void) | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useOutsideClick(menuRef, () => setMenuOpen(false), menuOpen);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  useEffect(
    () => () => removePointerListeners.current?.(),
    [],
  );

  const changeHeight = (direction: 1 | -1, large: boolean) => {
    setHeight((current) =>
      clampConsoleHeight(current + direction * (large ? CONSOLE_LARGE_STEP_PX : CONSOLE_STEP_PX)),
    );
  };

  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    changeHeight(event.key === "ArrowUp" ? 1 : -1, event.shiftKey);
  };

  const onSeparatorPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    removePointerListeners.current?.();
    const onPointerMove = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== event.pointerId || !dockRef.current) return;
      setHeight(clampConsoleHeight(dockRef.current.getBoundingClientRect().bottom - move.clientY));
    };
    const onPointerEnd = (end: globalThis.PointerEvent) => {
      if (end.pointerId !== event.pointerId) return;
      removeListeners();
    };
    const removeListeners = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      removePointerListeners.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    removePointerListeners.current = removeListeners;
  };

  const running = busy || kernel?.state === "running";
  const languageName = kernel?.language ?? language;
  return (
    <div
      ref={dockRef}
      className="nbp-console-dock"
      style={{ "--notebook-console-height": `${height}px` } as CSSProperties}
    >
      <div
        className="nbp-console-separator"
        role="separator"
        aria-label="Resize researcher console"
        aria-orientation="horizontal"
        aria-valuemin={CONSOLE_MIN_PX}
        aria-valuemax={CONSOLE_MAX_PX}
        aria-valuenow={height}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onSeparatorPointerDown}
      />
      {kernel ? (
        <div className="nbp-strip" data-testid="notebook-strip">
          <span className="nbp-strip-lang">{languageLabel(kernel.language)} kernel</span>
          <span className="nbp-strip-context">
            {contextName ? `“${contextLabel(contextName)}”` : "No context"}
          </span>
          <span className="nbp-strip-env">{kernel.environment}</span>
          <span className="nbp-strip-shared">shared with the agent</span>
          <span className={`nbp-strip-state nbp-strip-state--${kernel.state}`}>
            {kernel.state}
          </span>
          <div className="nbp-strip-menu" ref={menuRef}>
            <button
              type="button"
              ref={triggerRef}
              className="nbp-strip-more"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Kernel actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="nbp-strip-menulist" role="menu" aria-label="Kernel actions">
                {kernel.state === "running" && (
                  <button
                    type="button"
                    role="menuitem"
                    className="nbp-strip-menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onInterrupt();
                    }}
                  >
                    Interrupt
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="nbp-strip-menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRestart();
                  }}
                >
                  Restart
                  <span className="nbp-strip-menunote">clears every variable</span>
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        language !== null && (
          <div className="nbp-strip nbp-strip--idle" data-testid="notebook-strip">
            <span className="nbp-strip-lang">{languageLabel(language)} kernel</span>
            <span className="nbp-strip-context">
              {contextName ? `“${contextLabel(contextName)}”` : "No context"}
            </span>
            <span className="nbp-strip-state">not running</span>
          </div>
        )
      )}
      <div className="nbp-repl">
        <p className="nbp-greeting">
          {kernel ? (
            <>Connected to the agent&rsquo;s live kernel — variables and state are shared.</>
          ) : languageName !== null ? (
            <>This context ran {languageLabel(languageName)} here. Nothing is holding that namespace now, so there is nothing to run against.</>
          ) : (
            <>Nothing has run code on this Task yet.</>
          )}
        </p>
        {error && <p className="nbp-repl-error">{error}</p>}
        <div className="nbp-prompt">
          <span className="nbp-caret" aria-hidden="true">&gt;&gt;&gt;</span>
          <textarea
            className="nbp-input"
            rows={2}
            aria-label={kernel ? `Run ${languageLabel(kernel.language)} on this kernel` : "Run code on this kernel"}
            placeholder={kernel ? "df.shape" : "No kernel to run against"}
            value={code}
            disabled={busy || !kernel}
            onChange={(event) => onCodeChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onRun();
              }
            }}
          />
          {running ? (
            <button type="button" className="nbp-run nbp-run--stop" onClick={onInterrupt} disabled={!kernel}>
              Interrupt
            </button>
          ) : (
            <button type="button" className="nbp-run" onClick={onRun} disabled={code.trim().length === 0 || !kernel}>
              Run
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
