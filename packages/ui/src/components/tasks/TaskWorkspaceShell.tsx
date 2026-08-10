import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type React from "react";
import "./task-workspace.css";

export type TaskWorkspaceIntent = "closed" | "split" | "focus";
export type TaskWorkspaceSurface = "conversation" | "notebook";

export interface TaskWorkspaceController {
  intent: TaskWorkspaceIntent;
  activeSurface: TaskWorkspaceSurface;
  openNotebook(): void;
  closeNotebook(options?: { restoreFocus?: boolean }): void;
  focusNotebook(): void;
  exitFocus(): void;
  showSurface(surface: TaskWorkspaceSurface): void;
}

export const CONVERSATION_MIN_PX = 420;
export const NOTEBOOK_MIN_PX = 480;
export const WORKSPACE_DIVIDER_PX = 6;
export const SPLIT_STEP_PX = 16;
export const SPLIT_LARGE_STEP_PX = 64;

function clampRatio(ratio: number, width: number): number {
  const usable = Math.max(1, width - WORKSPACE_DIVIDER_PX);
  const min = CONVERSATION_MIN_PX / usable;
  const max = 1 - NOTEBOOK_MIN_PX / usable;
  return Math.min(max, Math.max(min, ratio));
}

export function useTaskWorkspace(resetKey: string): TaskWorkspaceController {
  const [intent, setIntent] = useState<TaskWorkspaceIntent>("closed");
  const [activeSurface, setActiveSurface] =
    useState<TaskWorkspaceSurface>("conversation");
  const openerRef = useRef<HTMLElement | null>(null);

  const openNotebook = useCallback(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActiveSurface("notebook");
    setIntent("split");
  }, []);

  const closeNotebook = useCallback(
    ({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
      setIntent("closed");
      setActiveSurface("conversation");
      if (restoreFocus) {
        queueMicrotask(() => {
          if (openerRef.current?.isConnected) openerRef.current.focus();
        });
      }
    },
    [],
  );

  const focusNotebook = useCallback(() => {
    setActiveSurface("notebook");
    setIntent("focus");
  }, []);

  const exitFocus = useCallback(() => {
    setIntent("split");
  }, []);

  const showSurface = useCallback((surface: TaskWorkspaceSurface) => {
    setActiveSurface(surface);
  }, []);

  useEffect(() => {
    setIntent("closed");
    setActiveSurface("conversation");
  }, [resetKey]);

  return {
    intent,
    activeSurface,
    openNotebook,
    closeNotebook,
    focusNotebook,
    exitFocus,
    showSurface,
  };
}

export function TaskWorkspaceShell(props: {
  controller: TaskWorkspaceController;
  conversation: React.ReactNode;
  notebook: React.ReactNode;
}): React.JSX.Element {
  const { controller, conversation, notebook } = props;
  const workspaceRef = useRef<HTMLDivElement>(null);
  const notebookHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousIntentRef = useRef(controller.intent);
  const draggingPointerRef = useRef<number | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);

  useEffect(() => {
    if (controller.intent === "closed") setSplitRatio(0.5);
  }, [controller.intent]);

  useEffect(() => {
    if (
      previousIntentRef.current === "closed" &&
      controller.intent !== "closed"
    ) {
      notebookHeadingRef.current?.focus();
    }
    previousIntentRef.current = controller.intent;
  }, [controller.intent]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const width =
        entries.find((entry) => entry.target === workspace)?.contentRect.width ??
        workspace.getBoundingClientRect().width;
      const minimumWideWidth =
        CONVERSATION_MIN_PX + NOTEBOOK_MIN_PX + WORKSPACE_DIVIDER_PX;
      if (width < minimumWideWidth) return;
      setSplitRatio((ratio) => clampRatio(ratio, width));
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const notebookOpen = controller.intent !== "closed";
  const singleCanvas = controller.intent === "focus";
  const conversationWidth = `calc(${splitRatio * 100}% - ${WORKSPACE_DIVIDER_PX / 2}px)`;
  const layoutStyle = {
    "--task-conversation-width": conversationWidth,
  } as React.CSSProperties;

  const resizeFromClientX = useCallback((clientX: number) => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) return;
    const usable = Math.max(1, rect.width - WORKSPACE_DIVIDER_PX);
    setSplitRatio(clampRatio((clientX - rect.left) / usable, rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      draggingPointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeFromClientX(event.clientX);
    },
    [resizeFromClientX],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (draggingPointerRef.current !== event.pointerId) return;
      resizeFromClientX(event.clientX);
    },
    [resizeFromClientX],
  );

  const finishPointerResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (draggingPointerRef.current !== event.pointerId) return;
      draggingPointerRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    [],
  );

  const handleSeparatorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const width = workspaceRef.current?.getBoundingClientRect().width ?? 0;
      const usable = Math.max(1, width - WORKSPACE_DIVIDER_PX);
      const step = event.shiftKey ? SPLIT_LARGE_STEP_PX : SPLIT_STEP_PX;
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      setSplitRatio((ratio) =>
        clampRatio(ratio + (direction * step) / usable, width),
      );
    },
    [],
  );

  return (
    <div
      ref={workspaceRef}
      className="task-workspace-shell"
      data-testid="task-workspace"
      data-intent={controller.intent}
      data-active-surface={controller.activeSurface}
    >
      {notebookOpen ? (
        <div className="task-workspace-chrome">
          <div className="task-workspace-tabs" role="tablist" aria-label="Task workspace">
            <button
              type="button"
              role="tab"
              aria-selected={controller.activeSurface === "conversation"}
              onClick={() => controller.showSurface("conversation")}
            >
              Conversation
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={controller.activeSurface === "notebook"}
              onClick={() => controller.showSurface("notebook")}
            >
              Notebook
            </button>
          </div>
          <div className="task-workspace-actions">
            {controller.intent === "focus" ? (
              <button type="button" onClick={controller.exitFocus}>
                Return to split
              </button>
            ) : (
              <button type="button" onClick={controller.focusNotebook}>
                Focus Notebook
              </button>
            )}
            <button type="button" onClick={() => controller.closeNotebook()}>
              Close Notebook
            </button>
          </div>
        </div>
      ) : null}

      <div
        className="task-workspace-layout"
        data-intent={controller.intent}
        data-active-surface={controller.activeSurface}
        style={layoutStyle}
      >
        <div
          className="task-workspace-pane task-workspace-conversation"
          hidden={singleCanvas && controller.activeSurface !== "conversation"}
        >
          {conversation}
        </div>
        {notebookOpen ? (
          <>
            <div
              className="task-workspace-divider"
              role="separator"
              aria-label="Resize Notebook"
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(splitRatio * 100)}
              tabIndex={0}
              onKeyDown={handleSeparatorKeyDown}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishPointerResize}
              onPointerCancel={finishPointerResize}
            />
            <div
              className="task-workspace-pane task-workspace-notebook"
              hidden={singleCanvas && controller.activeSurface !== "notebook"}
            >
              <h2 ref={notebookHeadingRef} tabIndex={-1}>
                Notebook
              </h2>
              {notebook}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
