/**
 * Where `StudyScreen` and `TaskScreen` actually wire the composer's
 * `blocker` prop, through `useRuntimeBlocker`. `Composer.test.tsx` covers the
 * component's own mechanism against a bare prop; this covers the condition
 * that feeds it — `hasWorkspaceServer()`, ownership of whatever
 * `listRuntimes()` answers, and the loading gap between the two — end to end
 * through a rendered screen.
 *
 * `createInMemoryApi()`'s `listRuntimes()` answers `[]` unconditionally,
 * whether or not a workspace server is declared. So the notice can only ever
 * be about the declared marker here, not about the seed — which is exactly
 * what proves the demo (no marker) is protected rather than accidentally
 * working.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createInMemoryApi, type LykeionApi, type Runtime } from "@lykeion/api";
import App from "../App";

const ROUTE = "#/studies/s_cmp/tasks/t_3";

function declareWorkspaceServer() {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "lykeion-workspace");
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
}

afterEach(() => {
  cleanup();
  document.querySelector('meta[name="lykeion-workspace"]')?.remove();
  window.history.replaceState({}, "", "/");
});

describe("the composer's runtime notice", () => {
  it("appears on a real lab whose workspace server has no daemon registered", async () => {
    declareWorkspaceServer();
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);

    expect(
      await screen.findByText(/no machine of yours is connected/i),
    ).toBeInTheDocument();
  });

  it("stays silent until the lab has actually answered, not while it is still being asked", async () => {
    // Against a real lab the question crosses the network. Treating the gap
    // before the answer as "no runtime" puts the notice up on every page
    // load and blocks anything typed in that window — the send returns with
    // the text still in the box and nothing said about why.
    declareWorkspaceServer();
    window.location.hash = ROUTE;
    let answer: (runtimes: Runtime[]) => void = () => {};
    const held = new Promise<Runtime[]>((resolve) => {
      answer = resolve;
    });
    const api = createInMemoryApi();
    render(<App api={{ ...api, listRuntimes: () => held }} />);

    await screen.findByTestId("task-surface");
    expect(screen.queryByText(/no machine of yours is connected/i)).toBeNull();

    answer([]);
    expect(
      await screen.findByText(/no machine of yours is connected/i),
    ).toBeInTheDocument();
  });

  it("stays silent in the browser-only demo, where the send is simulated rather than missing a runtime", async () => {
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);

    await screen.findByTestId("task-surface");
    expect(screen.queryByText(/no machine of yours is connected/i)).toBeNull();
  });

  it("reads listRuntimes once per mount on the Task surface, not once for the notice and again for the dock's machine names", async () => {
    declareWorkspaceServer();
    window.location.hash = ROUTE;
    const base = createInMemoryApi();
    let calls = 0;
    const api: LykeionApi = {
      ...base,
      listRuntimes: () => {
        calls += 1;
        return base.listRuntimes();
      },
    };
    render(<App api={api} />);

    await screen.findByTestId("task-surface");
    expect(calls).toBe(1);
  });

  it("reads listRuntimes once per mount on the Study surface", async () => {
    declareWorkspaceServer();
    window.location.hash = "#/studies/s_cmp";
    const base = createInMemoryApi();
    let calls = 0;
    const api: LykeionApi = {
      ...base,
      listRuntimes: () => {
        calls += 1;
        return base.listRuntimes();
      },
    };
    render(<App api={api} />);

    await screen.findByTestId("study-page");
    expect(calls).toBe(1);
  });
});
