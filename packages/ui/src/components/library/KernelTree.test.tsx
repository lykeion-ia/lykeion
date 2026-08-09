import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunningKernel, Runtime, Study, Task } from "@lykeion/api";
import { KernelTree } from "./KernelTree";

afterEach(cleanup);

const NOW = 1_700_000_000;

function machine(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: "rt_1",
    name: "ana-macbook",
    ownerId: "u_you",
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    health: "online",
    lastSeenTs: NOW,
    capabilities: [],
    ...overrides,
  };
}

let kernelSeq = 0;
function kernel(overrides: Partial<RunningKernel> = {}): RunningKernel {
  kernelSeq += 1;
  return {
    id: `k_${kernelSeq}`,
    runtimeId: "rt_1",
    studyId: "st_1",
    sessionId: "ses_1",
    taskId: "tk_1",
    name: "main",
    language: "python",
    state: "idle",
    incarnation: 1,
    executionCount: 1,
    queueDepth: 0,
    environment: "python",
    startedTs: NOW - 240,
    lastActivityTs: NOW - 240,
    ...overrides,
  };
}

const TASKS: Task[] = [
  {
    id: "tk_1",
    number: 14,
    studyId: "st_1",
    title: "Kinome screen",
    status: "in-progress",
    createdBy: "u_you",
    createdTs: NOW,
    updatedTs: NOW,
    assignees: [],
    runCount: 0,
  } as unknown as Task,
];

const STUDIES: Study[] = [
  {
    id: "st_1",
    key: "KIN",
    title: "CRISPR kinase screen",
    createdBy: "u_you",
    createdTs: NOW,
  } as unknown as Study,
];

function tree(runtimes: Runtime[], kernels: RunningKernel[], handlers = {}) {
  return render(
    <KernelTree
      runtimes={runtimes}
      kernels={kernels}
      tasks={TASKS}
      studies={STUDIES}
      now={NOW}
      onInterrupt={vi.fn()}
      onRestart={vi.fn()}
      {...handlers}
    />,
  );
}

it("groups a machine's kernels under the Task that is running them", () => {
  tree([machine()], [kernel({ language: "python" }), kernel({ language: "r" })]);

  expect(screen.getByText("ana-macbook")).toBeInTheDocument();
  expect(
    screen.getByText("CRISPR kinase screen › KIN-14 Kinome screen"),
  ).toBeInTheDocument();
  // One context, two languages — the shape a session that writes both has.
  expect(screen.getByText("Py")).toBeInTheDocument();
  expect(screen.getByText("R")).toBeInTheDocument();
});

it("renders an unreported figure as an em dash rather than as zero", () => {
  // Nothing on any machine reports resource use today. A zero here would be a
  // measurement, and this is the absence of one.
  tree([machine()], [kernel({ resources: undefined })]);

  const dashes = screen.getAllByText(/—/);
  expect(dashes.length).toBeGreaterThan(0);
  expect(screen.queryByText(/^0 B$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^0\.0$/)).not.toBeInTheDocument();
});

it("reports a measured zero as zero, and not as absent", () => {
  // The other half of the same rule: a machine that DID look and found no use
  // has said something, and the row must not erase it.
  tree([machine()], [kernel({ resources: { memoryBytes: 0, cpuPercent: 0 } })]);

  expect(screen.getByText("0 B")).toBeInTheDocument();
  expect(screen.getByText("0.0")).toBeInTheDocument();
});

it("calls an offline machine's kernels unknown rather than leaving them running", () => {
  tree([machine({ health: "offline" })], [kernel({ state: "running" })]);

  expect(screen.getByText("unknown")).toBeInTheDocument();
  expect(screen.queryByText("running")).not.toBeInTheDocument();
});

it("offers no lifecycle control for a kernel on a machine that is not answering", async () => {
  const user = userEvent.setup();
  tree([machine({ health: "offline" })], [kernel({ state: "running" })]);

  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  const menu = screen.getByRole("menu", { name: "Kernel actions" });
  expect(within(menu).queryByRole("menuitem", { name: /Restart/ })).not.toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: /Interrupt/ })).not.toBeInTheDocument();
  expect(within(menu).getByText(/This machine is offline/)).toBeInTheDocument();
});

it("offers Interrupt only while a cell is actually running", async () => {
  const user = userEvent.setup();
  const { unmount } = tree([machine()], [kernel({ state: "idle" })]);
  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  expect(
    within(screen.getByRole("menu")).queryByRole("menuitem", { name: /Interrupt/ }),
  ).not.toBeInTheDocument();
  unmount();

  tree([machine()], [kernel({ state: "running" })]);
  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  expect(
    within(screen.getByRole("menu")).getByRole("menuitem", { name: /Interrupt/ }),
  ).toBeInTheDocument();
});

it("reaches the kernel the row is for when Restart is chosen", async () => {
  const user = userEvent.setup();
  const onRestart = vi.fn();
  const k = kernel({ state: "idle" });
  tree([machine()], [k], { onRestart });

  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  await user.click(screen.getByRole("menuitem", { name: /Restart/ }));
  expect(onRestart).toHaveBeenCalledWith(k.id);
});

it("lists no machine that is holding nothing", () => {
  const { container } = tree([machine({ id: "rt_2", name: "empty-box" })], []);
  expect(screen.queryByText("empty-box")).not.toBeInTheDocument();
  expect(container).toBeEmptyDOMElement();
});

it("names a Task it cannot resolve as one, rather than printing its id", () => {
  tree([machine()], [kernel({ taskId: "tk_gone" })]);
  expect(screen.getByText("A Task not in this list")).toBeInTheDocument();
  expect(screen.queryByText(/tk_gone/)).not.toBeInTheDocument();
});

it("says how many cells are waiting behind the one running", () => {
  tree([machine()], [kernel({ state: "running", queueDepth: 3 })]);
  expect(screen.getByText(/3 queued/)).toBeInTheDocument();
});
