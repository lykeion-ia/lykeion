import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { RunningKernel } from "@lykeion/api";
import { NotebookStatusBar } from "./NotebookStatusBar";

afterEach(cleanup);

const k: RunningKernel = {
  id: "k_1",
  runtimeId: "rt_1",
  studyId: "st_1",
  sessionId: "ses_1",
  taskId: "tk_1",
  name: "main",
  language: "python",
  state: "idle",
  incarnation: 1,
  executionCount: 3,
  queueDepth: 0,
  environment: "python",
};

/**
 * `toHaveClass` alone cannot fail on what this state was flagged for: jsdom
 * resolves no cascade, so a class name built by string interpolation reads
 * as "styled" whether or not any rule targets it, lives in the right file,
 * or names a real token. Read straight off the stylesheet instead, the same
 * way `NotebookLedger.test.tsx` polices `.nbp-outputs`.
 */
const notebookCss = readFileSync(
  join(import.meta.dirname, "notebook.css"),
  "utf8",
);

function rule(selector: string): string {
  const match = notebookCss.match(
    new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`),
  );
  expect(match, `no ${selector} rule in notebook.css`).not.toBeNull();
  return match![1];
}

it("says a kernel was reclaimed rather than leaving an unstyled word", () => {
  render(
    <NotebookStatusBar
      kernel={{ ...k, state: "reclaimed" }}
      language="python"
      cellCount={3}
      onInterrupt={vi.fn()}
      onRestart={vi.fn()}
    />,
  );
  const el = screen.getByText("reclaimed");
  expect(el).toHaveClass("nbp-status-state--reclaimed");
  expect(rule(".nbp-status-state--reclaimed")).toMatch(
    /color:\s*var\(--ink-tertiary\)/,
  );
});
