/**
 * Where `StudyScreen` and `TaskScreen` actually wire the composer's
 * `blocker` prop, through `useMachineBlocker`. `Composer.test.tsx` covers the
 * component's own mechanism against a bare prop; this covers the condition
 * that feeds it — `hasWorkspaceServer()`, ownership of whatever
 * `listMachines()` answers, and the loading gap between the two — end to end
 * through a rendered screen.
 *
 * `createInMemoryApi()`'s `listMachines()` answers `[]` unconditionally,
 * whether or not a workspace server is declared. So the notice can only ever
 * be about the declared marker here, not about the seed — which is exactly
 * what proves the demo (no marker) is protected rather than accidentally
 * working.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createInMemoryApi, type LykeionApi, type Machine } from "@lykeion/api";
import App from "../App";
import { resetPageLoad } from "../lib/tabs-storage";
import { resetTabs } from "../lib/tabs";

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
  // The strip is a module store now, so the next test's fresh `<App>` would
  // otherwise still find the active tab on whatever route this one left it
  // at, and briefly render that surface before its own hash gets adopted.
  resetTabs();
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});

describe("the composer's machine notice", () => {
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
    // before the answer as "no machine" puts the notice up on every page
    // load and blocks anything typed in that window — the send returns with
    // the text still in the box and nothing said about why.
    declareWorkspaceServer();
    window.location.hash = ROUTE;
    let answer: (machines: Machine[]) => void = () => {};
    const held = new Promise<Machine[]>((resolve) => {
      answer = resolve;
    });
    const api = createInMemoryApi();
    render(<App api={{ ...api, listMachines: () => held }} />);

    await screen.findByTestId("task-surface");
    expect(screen.queryByText(/no machine of yours is connected/i)).toBeNull();

    answer([]);
    expect(
      await screen.findByText(/no machine of yours is connected/i),
    ).toBeInTheDocument();
  });

  it("stays silent in the browser-only demo, where the send is simulated rather than missing a machine", async () => {
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);

    await screen.findByTestId("task-surface");
    expect(screen.queryByText(/no machine of yours is connected/i)).toBeNull();
  });

  it("reads listMachines once per mount on the Task surface, not once for the notice and again for the dock's machine names", async () => {
    declareWorkspaceServer();
    window.location.hash = ROUTE;
    const base = createInMemoryApi();
    let calls = 0;
    const api: LykeionApi = {
      ...base,
      listMachines: () => {
        calls += 1;
        return base.listMachines();
      },
    };
    render(<App api={api} />);

    await screen.findByTestId("task-surface");
    expect(calls).toBe(1);
  });

  it("reads listMachines once per mount on the Study surface", async () => {
    declareWorkspaceServer();
    window.location.hash = "#/studies/s_cmp";
    const base = createInMemoryApi();
    let calls = 0;
    const api: LykeionApi = {
      ...base,
      listMachines: () => {
        calls += 1;
        return base.listMachines();
      },
    };
    render(<App api={api} />);

    await screen.findByTestId("study-page");
    expect(calls).toBe(1);
  });
});
