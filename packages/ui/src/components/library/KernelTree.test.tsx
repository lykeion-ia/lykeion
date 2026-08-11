import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type RunningKernel, type Runtime, type Study, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { taskLabeller } from "./KernelTree";
import { RuntimesList } from "./RuntimesList";

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

/**
 * The kernels as a researcher reaches them: nested inside the roster row for
 * the machine holding them. There is no kernel view apart from the roster any
 * more, so exercising one through anything but a row would be testing a
 * composition the screen does not use.
 */
function tree(runtimes: Runtime[], kernels: RunningKernel[], handlers = {}) {
  return render(
    <ApiProvider api={createInMemoryApi()}>
      <RuntimesList
        runtimes={runtimes}
        kernels={kernels}
        taskLabel={taskLabeller(TASKS, STUDIES)}
        now={NOW}
        meId="u_you"
        onInterrupt={vi.fn()}
        onRestart={vi.fn()}
        {...handlers}
      />
    </ApiProvider>,
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

it("gives a machine holding nothing no disclosure, and still lists the machine", () => {
  // The rule the old tree kept by hiding the machine outright. It cannot hide
  // it any more — this IS the roster, and a machine running nothing is still
  // a machine somebody paired — so the same fact is carried by the row having
  // nothing to open and saying nothing about kernels.
  tree([machine({ id: "rt_2", name: "empty-box" })], []);

  expect(screen.getByText("empty-box")).toBeInTheDocument();
  expect(screen.queryByRole("button", { expanded: true })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
  expect(screen.queryByText(/kernel/i)).not.toBeInTheDocument();
});

it("says on the row how many kernels a machine holds and how many are working", () => {
  // The one thing the machine header carried that the roster row did not
  // already say. Its memory and processor columns are not missed: nothing
  // reports either, so both read as em dashes on every machine.
  tree([machine()], [kernel({ state: "running" }), kernel({ state: "idle" })]);

  // Asserted through the disclosure's accessible name, which is the machine
  // and its summary — the Task group nested under it happens to hold the same
  // two kernels and says so in the same words, and a bare text query could
  // not tell which of the two levels answered.
  expect(
    screen.getByRole("button", { name: "ana-macbook — 2 kernels · 1 running" }),
  ).toBeInTheDocument();
});

it("opens a machine's kernels out of its own row, and closes them again", async () => {
  const user = userEvent.setup();
  tree([machine()], [kernel()]);

  // Open on arrival: a machine holding kernels is holding them now, and what
  // is running is the reason to be on this screen while something is.
  // Named exactly: the row also carries a Remove control naming the same
  // machine, and a loose match would not say which one was clicked.
  const row = screen.getByRole("button", { name: "ana-macbook — 1 kernel" });
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("CRISPR kinase screen › KIN-14 Kinome screen")).toBeInTheDocument();

  await user.click(row);
  expect(row).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByText("CRISPR kinase screen › KIN-14 Kinome screen"),
  ).not.toBeInTheDocument();
  // The machine stays on the roster with its row closed — collapsing what it
  // holds is not the machine leaving the lab.
  expect(screen.getByText("ana-macbook")).toBeInTheDocument();
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
