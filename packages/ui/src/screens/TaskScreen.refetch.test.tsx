/**
 * A write of the surface's OWN must not blank the conversation.
 *
 * Mark Done, a rename and filing each re-read the Task, and a re-read that
 * clears what it had first takes the whole page down with it for a commit: the
 * transcript unmounts, the scroll position goes, and the `role="log"` region
 * is built again from scratch — which is a fresh live region for a screen
 * reader. The surface holds the last record it read so the next one replaces
 * it in place; only the FIRST load has nothing to show.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type {
  ChangeEvent,
  KernelEnvDeclaration,
  KernelEnvStatus,
  LykeionApi,
  TaskEnvironmentSetup,
  Transport,
} from "@lykeion/api";
import App from "../App";
import { ApiProvider } from "../api/ApiContext";
import { useChangeChannel } from "../hooks/useChangeChannel";
import { RouterProvider } from "../router";
import { TaskScreen } from "./TaskScreen";
import { markTaskDone } from "../test/task-row-menu";

const STUDY = "s_cmp";
// The seeded Task that IS a conversation: two turns, and In Review, which is
// the state Mark Done is offered from.
const TASK = "t_3";
const TASK_TITLE = "Preprocess two-photon calcium traces";

beforeEach(cleanup);

describe("re-reading the open Task", () => {
  it("keeps the transcript across a mark-done", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    // Clear the Done-gate first: this is about the re-read that FOLLOWS a
    // successful write, not about the gate itself.
    for (const f of await api.reviewFindings(STUDY, TASK)) {
      await api.resolveFinding(STUDY, TASK, f.id);
    }

    window.location.hash = `#/researches/${STUDY}/tasks/${TASK}`;
    render(<App api={api} />);

    const stream = await screen.findByTestId("conv-stream");
    const turn = await screen.findByText(
      /Motion-correct the deprivation cohort/i,
    );

    await markTaskDone(user, TASK_TITLE);

    await waitFor(async () =>
      expect((await api.getTask(TASK)).task.status).toBe("done"),
    );

    // The very same nodes, not equal-looking replacements: an unmount would
    // hand back new ones, and take the researcher's scroll position with it.
    expect(screen.getByTestId("conv-stream")).toBe(stream);
    expect(
      screen.getByText(/Motion-correct the deprivation cohort/i),
    ).toBe(turn);
  });

  it("keeps them across a rename of the Task on screen", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = `#/researches/${STUDY}/tasks/${TASK}`;
    render(<App api={api} />);

    const stream = await screen.findByTestId("conv-stream");
    const title = (await api.getTask(TASK)).task.title;

    await user.click(
      await screen.findByRole("button", { name: `Task actions for ${title}` }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", {
      name: `Rename ${title}`,
    });
    await user.clear(field);
    await user.type(field, "Preprocessing, revisited{Enter}");

    await waitFor(async () =>
      expect((await api.getTask(TASK)).task.title).toBe(
        "Preprocessing, revisited",
      ),
    );
    expect(screen.getByTestId("conv-stream")).toBe(stream);
  });
});

/**
 * The environment bar's other re-read: the one that happens because the SERVER
 * pushed a change, and the one that happens because this tab was closed and
 * reopened.
 *
 * The bar holds no copy of a build. Everything it says comes from
 * `taskEnvironmentSetups`, so a Task reopened mid-build has to come back saying
 * exactly what the server says — and must never fall back to the "Setup needed"
 * it would derive from a machine's own status if it decided anything for
 * itself.
 *
 * `TaskScreen` is mounted directly rather than through `App` because `App`
 * hands its own provider a `transport` of `undefined` whenever an `api` is
 * injected (`App.tsx:124`), and this file's whole point is to drive the real
 * change channel. Composed here from the same three pieces `App` composes —
 * `ApiProvider`, `useChangeChannel`, `RouterProvider` — so the frame travels
 * the path a real server's frame travels.
 */
const ENV_TASK = "t_3";

const declaration: KernelEnvDeclaration = {
  name: "meta-analysis-r",
  language: "r",
  manager: "conda",
  packages: ["metafor"],
  createdBy: "u_you",
  createdTs: 0,
  lockRevision: 1,
};

/** The machine's own report: it does NOT hold this environment. Left this way
 *  on purpose — it is exactly what the bar would derive "Setup needed" from if
 *  it ever preferred its own reading to the server's durable job. */
const absentOnMachine: KernelEnvStatus = {
  state: "absent",
  name: "meta-analysis-r",
  language: "r",
  manager: "conda",
  platform: "macos-aarch64",
  root: "/x/envs/meta-analysis-r",
};

const buildingJob: TaskEnvironmentSetup = {
  job: {
    id: "job_1",
    machineId: "rt_1",
    machineName: "ana-macbook",
    environmentName: "meta-analysis-r",
    language: "r",
    manager: "conda",
    lockRevision: 1,
    state: "building",
    stage: "installing",
    requestedTs: 1_700_000_000,
    updatedTs: 1_700_000_000,
    log: ["Installing metafor"],
  },
};

/** A lab whose environment answers are whatever `setups` currently returns —
 *  the one seam the bar reads a build through. */
function labWithSetups(setups: () => TaskEnvironmentSetup[]): LykeionApi {
  return {
    ...createInMemoryApi(),
    kernelEnvList: async () => [declaration],
    taskNotebook: async () => [],
    listRunningKernels: async () => [],
    listMachines: async () => [
      {
        id: "rt_1",
        name: "ana-macbook",
        ownerId: "u_you",
        platform: "macos-aarch64",
        daemonVersion: "0.1.0",
        health: "online",
        lastSeenTs: 1,
        capabilities: [],
      },
    ],
    computeSnapshot: async () => [{ machineId: "rt_1", environments: [absentOnMachine] }],
    taskEnvironmentSetups: async () => setups(),
  };
}

/** A transport whose workspace change stream this test drives by hand — the
 *  same shape `useChangeChannel.test.tsx` uses to drive the hook. */
function controllableTransport() {
  let push: ((event: ChangeEvent) => void) | undefined;
  const transport: Transport = {
    request: async () => null,
    openEvents(_cursor, onEvent) {
      push = onEvent;
      return () => {};
    },
    openRun: () => () => {},
  };
  return {
    transport,
    /** Push one real change frame, of the kind the server actually records for
     *  an environment setup (`api/environments.ts`'s
     *  `record("environment-setup-changed", …)`). */
    pushEnvironmentSetupChanged(seq: number) {
      act(() => push!({ seq, kind: "environment-setup-changed", payload: {} }));
    },
  };
}

/** `App`'s own `ChangeChannel`, which is not exported — the same one line. */
function ChangeChannel({ transport }: { transport: Transport }) {
  useChangeChannel(transport);
  return null;
}

function mountTaskScreen(api: LykeionApi, transport: Transport) {
  window.location.hash = `#/researches/${STUDY}/tasks/${ENV_TASK}`;
  return render(
    <ApiProvider api={api}>
      <ChangeChannel transport={transport} />
      <RouterProvider>
        <TaskScreen researchId={STUDY} taskId={ENV_TASK} />
      </RouterProvider>
    </ApiProvider>,
  );
}

/**
 * Flushes the pending reads and NOTHING else — microtasks only, no clock.
 *
 * This is what makes the push below attributable. The panel also polls, every
 * 1500ms (`NotebookPanel.tsx:226`), so a `waitFor` after the push would be
 * satisfied by the poll and would prove nothing about the frame. Three awaited
 * microtasks take microseconds; a real interval cannot fire inside one. So if
 * the bar has changed by the time this returns, the change channel is what
 * changed it.
 */
async function settleReads() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Opens this Task's notebook the way the surface offers it — the composer's
 *  button — and hands back the bar's own live region. */
async function openEnvironmentBar(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: "Open notebook" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await screen.findByTestId("notebook-panel");
  return within(await screen.findByTestId("environment-bar")).getByRole("status");
}

describe("the environment bar across a pushed change and a remount", () => {
  it("comes back mid-build from the server's own record, with no stale Setup needed", async () => {
    const user = userEvent.setup();
    let setups: TaskEnvironmentSetup[] = [];
    const api = labWithSetups(() => setups);
    const driver = controllableTransport();

    const first = mountTaskScreen(api, driver.transport);
    const bar = await openEnvironmentBar(user);

    // Before the server has a build to report, the bar says what the MACHINE
    // reported — this is the sentence that must not survive the build.
    expect(bar).toHaveTextContent("Setup needed");

    // The server now holds a durable build.
    setups = [buildingJob];

    // Nothing has told the surface yet: `settleReads` moves no clock, so the
    // panel's own 1500ms poll cannot have fired inside it. This assertion is
    // what makes the next one mean something — without it, the poll would
    // deliver the change a moment later and the push below would be proving
    // nothing.
    await settleReads();
    expect(bar).toHaveTextContent("Setup needed");

    // Now the server pushes the change frame it records for a setup
    // (`environment-setup-changed`), through the real `useChangeChannel`. The
    // surface re-reads `taskEnvironmentSetups` and learns the build from
    // there and from nowhere else — the frame carries no payload the bar
    // could have drawn.
    driver.pushEnvironmentSetupChanged(1);
    await settleReads();
    expect(bar).toHaveTextContent("Installing packages");

    // The tab is closed and reopened. Nothing about the build is carried
    // across in the browser — it is read again.
    first.unmount();
    mountTaskScreen(api, driver.transport);
    const remounted = await openEnvironmentBar(user);

    await waitFor(() => expect(remounted).toHaveTextContent("Installing packages"));
    // The machine still reports `absent`, so a surface that derived its own
    // answer would say this. None of it appears.
    expect(remounted).not.toHaveTextContent("Setup needed");
    expect(screen.queryByText("Setup needed")).toBeNull();
    // And the progress track is the indeterminate one, with no number invented
    // for it.
    const progress = within(screen.getByTestId("environment-bar")).getByRole("progressbar");
    expect(progress).not.toHaveAttribute("aria-valuenow");
  });
});
