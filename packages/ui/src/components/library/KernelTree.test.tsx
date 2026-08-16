import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type RunningKernel, type Machine, type Study, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { taskLabeller } from "./KernelTree";
import { MachinesList } from "./MachinesList";

afterEach(cleanup);

const NOW = 1_700_000_000;

function machine(overrides: Partial<Machine> = {}): Machine {
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
    machineId: "rt_1",
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
function tree(machines: Machine[], kernels: RunningKernel[], handlers = {}) {
  return render(
    <ApiProvider api={createInMemoryApi()}>
      <MachinesList
        machines={machines}
        kernels={kernels}
        taskLabel={taskLabeller(TASKS, STUDIES)}
        now={NOW}
        meId="u_you"
        onInterrupt={vi.fn()}
        onStop={vi.fn()}
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
  // A machine that could not read a kernel's process, or has not read it yet,
  // sends no `resources` at all. A zero here would be a measurement, and this
  // is the absence of one.
  tree([machine()], [kernel({ resources: undefined })]);

  const dashes = screen.getAllByText(/—/);
  expect(dashes.length).toBeGreaterThan(0);
  expect(screen.queryByText(/^0 B$/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^0\.0$/)).not.toBeInTheDocument();
});

it("draws a kernel's shape over time against the machine holding it, not against its own peak", () => {
  // The call site, which nothing queried: `Sparkline`'s own suite pins that
  // it honours the ceiling it is handed, and this pins which ceiling a
  // kernel row hands it. An idle kernel holding 600 KB and one eating 6 GB
  // are each their own maximum, so auto-scaling — every library's default,
  // and the thing the component exists to refuse — would draw the two
  // identically. The machine's own compute row carries no series, so the
  // only sparkline on screen is the kernel's.
  tree([machine()], [kernel({ series: [{ memoryBytes: 600_000 }, { memoryBytes: 1_200_000 }] })], {
    compute: [{ machineId: "rt_1", totalMemoryBytes: 8 * 1024 * 1024 * 1024, cores: 8 }],
  });

  expect(screen.getByLabelText("Memory over time").textContent).toBe("▁▁");
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

it("offers Stop only while something is running", async () => {
  // The sentence a stop carries is answered to the cell that is running, so a
  // kernel with nothing in it has no call for it to reach.
  const user = userEvent.setup();
  const { unmount } = tree([machine()], [kernel({ state: "idle" })]);
  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  expect(
    within(screen.getByRole("menu")).queryByRole("menuitem", { name: /^Stop$/ }),
  ).not.toBeInTheDocument();
  unmount();

  tree([machine()], [kernel({ state: "running" })]);
  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  expect(
    within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Stop$/ }),
  ).toBeInTheDocument();
});

it("sends what the researcher typed", async () => {
  const user = userEvent.setup();
  const onStop = vi.fn();
  const k = kernel({ state: "running" });
  tree([machine()], [k], { onStop });

  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  await user.click(screen.getByRole("menuitem", { name: /^Stop$/ }));
  await user.type(
    screen.getByRole("textbox", { name: /Why the Py kernel is being stopped/i }),
    "redo this using less memory",
  );
  await user.click(screen.getByRole("button", { name: /^Stop$/ }));

  expect(onStop).toHaveBeenCalledWith(k.id, "redo this using less memory");
});

it("backs out of a stop on Esc without ending anything", async () => {
  // Opening the composer is not the command. A researcher who chose Stop by
  // mistake must not have to send a sentence to get out of it.
  const user = userEvent.setup();
  const onStop = vi.fn();
  tree([machine()], [kernel({ state: "running" })], { onStop });

  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  await user.click(screen.getByRole("menuitem", { name: /^Stop$/ }));
  const box = screen.getByRole("textbox", { name: /Why the Py kernel is being stopped/i });
  await user.type(box, "second thoughts{Escape}");

  expect(onStop).not.toHaveBeenCalled();
  expect(box).not.toBeInTheDocument();
  // And the figures the composer stood in front of are back.
  expect(screen.getByRole("button", { name: /Actions for the Py kernel/i })).toBeInTheDocument();
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
  // already say. Its memory and processor columns are not missed: the row has
  // a column each for them now, summed over these same kernels.
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
