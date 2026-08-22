import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type EnvironmentSetupJob,
  type KernelEnvDeclaration,
  type KernelEnvState,
  type KernelEnvStatus,
  type LykeionApi,
  type MachineCompute,
  type NotebookCell,
  type TaskEnvironmentSetup,
  type RunningKernel,
  type Machine,
} from "@lykeion/api";
import { ApiProvider, useDataVersion } from "../../api/ApiContext";
import { NotebookPanel as NotebookPanelUnderTest } from "./NotebookPanel";
import recordedRCell from "./__fixtures__/r-cell.json";

function NotebookPanel(
  props: Omit<ComponentProps<typeof NotebookPanelUnderTest>, "sessionLabel">,
) {
  return <NotebookPanelUnderTest {...props} sessionLabel="Guide design" />;
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

let cellSeq = 0;
function cell(overrides: Partial<NotebookCell> = {}): NotebookCell {
  cellSeq += 1;
  return {
    id: `cell_${cellSeq}`,
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: cellSeq,
    source: "1 + 1",
    origin: { surface: "repl", by: "mem_1" },
    ok: true,
    wallMs: 4,
    ts: 1,
    outputs: [],
    ...overrides,
  };
}

let kernelSeq = 0;
function kernel(overrides: Partial<RunningKernel> = {}): RunningKernel {
  kernelSeq += 1;
  return {
    id: `k_${kernelSeq}`,
    machineId: "rt_1",
    researchId: "st_1",
    sessionId: "ses_1",
    taskId: "tk_1",
    name: "main",
    language: "python",
    state: "idle",
    incarnation: 1,
    executionCount: 0,
    queueDepth: 0,
    environment: "python",
    ...overrides,
  };
}

const env = (name: string, state: KernelEnvState = "ready"): KernelEnvStatus => ({
  state,
  platform: "macos-aarch64",
  root: `/x/envs/${name}`,
  name,
  language: name === "r" ? "r" : "python",
  manager: name === "python" ? "uv" : "conda",
});

/** One machine as `computeSnapshot` reports it. `environments` is left off
 *  entirely when a test means "this machine has not reported" — which is a
 *  different fact from a machine reporting it holds none, and the panel is
 *  required to tell them apart. */
const machine = (machineId: string, environments?: KernelEnvStatus[]): MachineCompute => ({
  machineId,
  ...(environments === undefined ? {} : { environments }),
});

/** The same machine as `listMachines` knows it — where its name lives. A
 *  researcher choosing between two machines chooses between "laptop" and
 *  "workstation", not between two opaque ids. */
const paired = (id: string, name: string): Machine => ({
  id,
  name,
  ownerId: "u_test",
  platform: "macos-aarch64",
  daemonVersion: "0.1.0",
  health: "online",
  lastSeenTs: 1,
  capabilities: ["sessions", "kernels"],
});

/** `kernelEnvList` now answers with the lab's declarations, not a
 *  per-machine status — a different shape from `env()` above, which is
 *  still what a machine reports. */
const envDecl = (name: string): KernelEnvDeclaration => ({
  name,
  language: name === "r" ? "r" : "python",
  manager: name === "python" ? "uv" : "conda",
  packages: [],
  createdBy: "u_test",
  createdTs: 0,
  lockRevision: 0,
});

/** One durable setup job for `crispr` on `rt_1`, as the server projects it.
 *  Nothing here is a claim the browser makes: these fixtures stand in for the
 *  answers `taskEnvironmentSetups` gives, which is the only place the panel
 *  learns any of it from. */
const setupFixture = (
  over: Partial<EnvironmentSetupJob> = {},
): TaskEnvironmentSetup => ({
  job: {
    id: "job_1",
    machineId: "rt_1",
    machineName: "rt_1",
    environmentName: "crispr",
    language: "python",
    manager: "conda",
    lockRevision: 0,
    state: "requested",
    stage: "waiting-for-machine",
    requestedTs: 1_700_000_000_000,
    updatedTs: 1_700_000_000_000,
    log: [],
    ...over,
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Boilerplate for the language-scoping tests below: a lab whose
 *  `kernelEnvList` answers with the given declarations and whose notebook
 *  holds the given cells, with nothing else this task's tests care about. */
function renderPanel({
  envs,
  cells,
  built,
}: {
  envs: KernelEnvDeclaration[];
  cells: NotebookCell[];
  /** Which of `envs` this machine reports as BUILT. Given explicitly because
   *  the picker also offers what is unbuilt — that is the only route to
   *  building it — so a fixture that says nothing about build state is a
   *  fixture whose picker contents depend on when the compute snapshot
   *  happens to land. Omitted means "all of them", the settled state most of
   *  these tests are about. */
  built?: string[];
}) {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => envs,
    taskNotebook: async () => cells,
    // No kernel stub on purpose: one machine in the snapshot is enough for
    // the panel to settle on it, and a running kernel would also decide
    // `shownLang` — a Python one here would scope the picker to Python and
    // quietly defeat every test below that views R.
    computeSnapshot: async () => [
      machine(
        "rt_1",
        envs.map((e) => env(e.name, built === undefined || built.includes(e.name) ? "ready" : "absent")),
      ),
    ],
  };
  return render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);
}

/** The bar's own live region. Addressed through the bar rather than as "the
 *  live region", because the panel keeps a second one for a failed poll and a
 *  bare `getByRole("status")` would be asking which of the two a test meant. */
const barStatus = () =>
  within(screen.getByTestId("environment-bar")).getByRole("status");

/** The control that opens the environment list. Its accessible name carries
 *  what is chosen, which is how these tests read the selection without
 *  reaching for a class name. */
const envTrigger = () => screen.getByRole("button", { name: /^Kernel environment:/ });

it("withdraws the previous Task's cells and kernel authority immediately", async () => {
  const pendingCells = deferred<NotebookCell[]>();
  const pendingKernels = deferred<RunningKernel[]>();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async (taskId) =>
      taskId === "task_a"
        ? [cell({ name: "main", source: "task_a_secret = 42" })]
        : pendingCells.promise,
    listRunningKernels: vi
      .fn<LykeionApi["listRunningKernels"]>()
      .mockResolvedValueOnce([
        kernel({ taskId: "task_a", name: "main", language: "python", state: "idle" }),
      ])
      .mockImplementationOnce(() => pendingKernels.promise),
  };
  const { rerender } = render(
    <ApiProvider api={api}><NotebookPanel taskId="task_a" /></ApiProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("notebook-cells")).toHaveTextContent("task_a_secret = 42"),
  );
  // Authority over a live kernel is visible as the controls that act on it.
  expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();

  rerender(
    <ApiProvider api={api}><NotebookPanel taskId="task_b" /></ApiProvider>,
  );

  expect(screen.getByTestId("notebook-cells")).not.toHaveTextContent("task_a_secret = 42");
  // Withdrawn on the same tick as the cells: no control here still acts on the
  // previous Task's kernel.
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Interrupt" })).not.toBeInTheDocument();

  await act(async () => {
    pendingCells.resolve([]);
    pendingKernels.resolve([]);
    await Promise.resolve();
  });
});

it("discards Task A reads that resolve after Task B is active", async () => {
  const taskACells = deferred<NotebookCell[]>();
  const taskAKernels = deferred<RunningKernel[]>();
  const taskBCell = cell({
    name: "main",
    language: "r",
    source: "task_b_value <- 7",
  });
  const taskNotebook = vi
    .fn<LykeionApi["taskNotebook"]>()
    .mockImplementation(async (taskId) =>
      taskId === "task_a" ? taskACells.promise : [taskBCell],
    );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook,
    listRunningKernels: vi
      .fn<LykeionApi["listRunningKernels"]>()
      .mockImplementationOnce(() => taskAKernels.promise)
      .mockResolvedValueOnce([
        kernel({ taskId: "task_b", name: "main", language: "r", state: "idle" }),
      ]),
  };
  const { rerender } = render(
    <ApiProvider api={api}><NotebookPanel taskId="task_a" /></ApiProvider>,
  );
  await waitFor(() => expect(taskNotebook).toHaveBeenCalledWith("task_a"));

  rerender(
    <ApiProvider api={api}><NotebookPanel taskId="task_b" /></ApiProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("notebook-cells")).toHaveTextContent("task_b_value <- 7"),
  );
  expect(screen.getByTestId("notebook-status")).toHaveTextContent(/R/);

  await act(async () => {
    taskACells.resolve([
      cell({ name: "main", language: "python", source: "late_task_a = True" }),
    ]);
    taskAKernels.resolve([
      kernel({ taskId: "task_a", name: "main", language: "python", state: "idle" }),
    ]);
    await Promise.resolve();
  });

  expect(screen.getByTestId("notebook-cells")).toHaveTextContent("task_b_value <- 7");
  expect(screen.getByTestId("notebook-cells")).not.toHaveTextContent("late_task_a = True");
  expect(screen.getByTestId("notebook-status")).toHaveTextContent(/R/);
});

it("groups a Task's cells by the context that ran them", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", source: "import numpy as np" })],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByText("import numpy as np")).toBeInTheDocument());
  expect(screen.getByText("Main agent")).toBeInTheDocument();
  expect(screen.queryByRole("tablist", { name: "Kernel context" })).toBeNull();
});

it("shows only the selected context's cells, and swaps them when the tab does", async () => {
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [
      cell({ name: "main", source: "import numpy as np" }),
      cell({ name: "worker", source: "df <- read.csv('kinome.csv')", language: "r" }),
    ],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle" }),
      kernel({ name: "worker", language: "r", state: "idle" }),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByText("import numpy as np")).toBeInTheDocument());
  expect(screen.queryByText("df <- read.csv('kinome.csv')")).not.toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: /worker/i }));
  await waitFor(() =>
    expect(screen.getByText("df <- read.csv('kinome.csv')")).toBeInTheDocument(),
  );
  expect(screen.queryByText("import numpy as np")).not.toBeInTheDocument();
});

it("names the static context without exposing an opaque session id", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", sessionId: "ses_1", state: "idle" }),
      kernel({ name: "main", language: "r", sessionId: "ses_2", state: "idle" }),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  const context = await screen.findByText("Main agent");
  expect(context).not.toHaveTextContent("ses_1");
  expect(context).not.toHaveTextContent("ses_2");
});

it("keeps a cell's output out of the way until it is asked for", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ outputs: [{ kind: "stream", name: "stdout", text: "loaded\n" }] })],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  const disclosure = await screen.findByText(/^output/);
  expect(disclosure.closest("details")).not.toHaveAttribute("open");
});

it("keeps confirmed cells visible when a notebook refresh fails", async () => {
  vi.useFakeTimers();
  const confirmed = cell({ name: "main", source: "confirmed_result = 42" });
  const taskNotebook = vi
    .fn<LykeionApi["taskNotebook"]>()
    .mockResolvedValueOnce([confirmed])
    .mockRejectedValueOnce(new Error("notebook unavailable"))
    .mockResolvedValueOnce([confirmed]);
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook,
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle" }),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTestId("notebook-cells")).toHaveTextContent("confirmed_result = 42");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(screen.getByTestId("notebook-cells")).toHaveTextContent("confirmed_result = 42");
  // Addressed by its words rather than by "the live region": the
  // environment bar keeps one of its own now, and a bare `getByRole("status")`
  // would be asking which of two announcements this test meant.
  expect(
    screen.getByText("Could not refresh the notebook. Showing the last confirmed cells."),
  ).toHaveAttribute("role", "status");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(
    screen.queryByText("Could not refresh the notebook. Showing the last confirmed cells."),
  ).not.toBeInTheDocument();
});

it("withdraws live-kernel authority when kernel status cannot be refreshed", async () => {
  vi.useFakeTimers();
  const running = kernel({ name: "main", language: "python", state: "idle" });
  const listRunningKernels = vi
    .fn<LykeionApi["listRunningKernels"]>()
    .mockResolvedValueOnce([running])
    .mockRejectedValueOnce(new Error("kernel status unavailable"))
    .mockResolvedValueOnce([running]);
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", source: "durable = True" })],
    listRunningKernels,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByTestId("notebook-status")).toHaveTextContent(/shared with the agent/);
  expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(screen.getByTestId("notebook-status")).toHaveTextContent(/view only/);
  expect(
    screen.getByText("Kernel status is unavailable. Code execution is disabled."),
  ).toHaveAttribute("role", "status");
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(
    screen.queryByText("Kernel status is unavailable. Code execution is disabled."),
  ).not.toBeInTheDocument();
  expect(screen.getByTestId("notebook-status")).toHaveTextContent(/shared with the agent/);
  expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
});

it("names the language of the kernel it is showing", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listRunningKernels: async () => [kernel({ name: "main", language: "r", state: "idle" })],
    taskNotebook: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByTestId("notebook-status")).toHaveTextContent(/^R/));
  expect(screen.getByTestId("notebook-status")).not.toHaveTextContent(/Python/);
});

it("offers to build the environment on screen when the machine reports it absent", async () => {
  // The two facts the bar joins. The lab declared this environment; the
  // machine holding this Task's kernel says it has not built it — so the one
  // control offers exactly that build, named for both of them, because a
  // button reading "Set up" alone leaves out which computer downloads the
  // gigabyte.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [
      cell({ name: "main", environment: "crispr", source: "import scanpy" }),
    ],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1", [env("crispr", "absent")])],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  const button = await screen.findByRole("button", { name: "Set up crispr on rt_1" });
  expect(button).toHaveAttribute("aria-disabled", "false");
  expect(barStatus()).toHaveTextContent("Setup needed");
});

it("names a rebuild rather than a first build for a copy the machine reports broken", async () => {
  // `broken` is a provision that began and was interrupted, and its remedy is
  // to provision it again. Telling a researcher their half-built environment
  // has never been built is telling them something false about their own
  // machine — and a job that has not failed does not make this a failure
  // either, so the line still reads as work outstanding rather than as an
  // error.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1", [env("crispr", "broken")])],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  expect(
    await screen.findByRole("button", { name: "Rebuild crispr on rt_1" }),
  ).toBeInTheDocument();
  expect(barStatus()).toHaveTextContent("Setup needed");
  expect(barStatus()).not.toHaveTextContent("Setup failed");
});

it("says Ready for an environment the machine already holds, and offers nothing to press", async () => {
  // Nothing to provision, so nothing offers to provision it. The BAR stays —
  // it is the one line that says what this notebook runs in — but an offer to
  // rebuild what is already there asks a researcher to spend a gigabyte on
  // nothing, and this Task has asked for no build to keep a control alive for.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python")],
    taskNotebook: async () => [cell({ name: "main", environment: "python" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1", [env("python", "ready")])],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(barStatus()).toHaveTextContent("Ready"));
  expect(screen.getByRole("button", { name: "Kernel environment: python" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^(Set up|Rebuild)/ }),
  ).not.toBeInTheDocument();
});

it("offers a rebuild once a build this Task asked for has gone ready", async () => {
  // The other half of the same rule. A durable job for this Task is what puts
  // the control on the bar and what keeps it there — through `requested`,
  // `building` and the tick it finishes on, which is the tick a researcher's
  // finger is still resting on it.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python")],
    taskNotebook: async () => [cell({ name: "main", environment: "python" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1", [env("python", "ready")])],
    taskEnvironmentSetups: async () => [
      setupFixture({
        environmentName: "python",
        state: "ready",
        stage: "finalizing",
        startedTs: 1_700_000_000_000,
        finishedTs: 1_700_000_030_000,
        updatedTs: 1_700_000_030_000,
      }),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(barStatus()).toHaveTextContent("Ready"));
  expect(
    await screen.findByRole("button", { name: "Rebuild python on rt_1" }),
  ).toBeInTheDocument();
});

it("reads a machine with no environments field as one that has not reported", async () => {
  // Absent is not zero. A machine that has never told this lab what it holds
  // and one that told it "none" are different facts, and only the second is
  // something a press can act on. The button stays on the bar and refuses,
  // rather than vanishing: what is missing is the machine's answer, not the
  // control.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(barStatus()).toHaveTextContent("Waiting for rt_1 to report"),
  );
  expect(screen.getByRole("button", { name: "Set up crispr on rt_1" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("asks which machine should build when several are paired and no kernel names one", async () => {
  // A phase-4 ruling: inferring the machine would be this product silently
  // choosing which of a member's several paired computers downloads a
  // gigabyte. With no kernel running there is nothing here that knows, so the
  // researcher is asked — and until they answer there is no build to name,
  // because a build with no machine in its sentence is the same silent pick
  // wearing a shorter label.
  const user = userEvent.setup();
  const requestKernelEnvironmentSetup = vi.fn(async () => ({ jobId: "job_1" }));
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [],
    computeSnapshot: async () => [
      machine("rt_1", [env("crispr", "absent")]),
      machine("rt_2", [env("crispr", "absent")]),
    ],
    listMachines: async () => [paired("rt_1", "laptop"), paired("rt_2", "workstation")],
    requestKernelEnvironmentSetup,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(barStatus()).toHaveTextContent("Choose which machine builds it"),
  );
  expect(screen.queryByRole("button", { name: /^Set up/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /^Machine:/ }));
  const list = screen.getByRole("listbox", { name: "Machine" });
  expect(within(list).getByRole("option", { name: "laptop" })).toBeVisible();
  await user.click(within(list).getByRole("option", { name: "workstation" }));

  await user.click(
    await screen.findByRole("button", { name: "Set up crispr on workstation" }),
  );
  // The machine they chose, and not the first one in the list.
  await waitFor(() =>
    expect(requestKernelEnvironmentSetup).toHaveBeenCalledWith({
      taskId: "tk_1",
      machineId: "rt_2",
      environmentName: "crispr",
    }),
  );
});

it("asks which machine when this Task's kernels are running on two of them", async () => {
  // A running kernel names the machine this Task executes on — but only where
  // this Task's running kernels agree on one. Taking the first of two would
  // be the same silent pick the phase-4 ruling forbids, wearing a running
  // kernel as its excuse.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
      kernel({ name: "main", language: "r", state: "idle", machineId: "rt_2" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("crispr", "absent")]),
      machine("rt_2", [env("crispr", "absent")]),
    ],
    listMachines: async () => [paired("rt_1", "laptop"), paired("rt_2", "workstation")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(barStatus()).toHaveTextContent("Choose which machine builds it"),
  );
  expect(screen.getByRole("button", { name: /^Machine:/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Set up/ })).not.toBeInTheDocument();
});

it("still offers to build when listMachines fails, and names the machine by its raw id", async () => {
  // F2: `computeSnapshot` and `listMachines` used to share one `Promise.all`
  // and one `catch`, so a rejecting `listMachines` threw away a
  // `computeSnapshot` that had already succeeded and the whole build surface
  // went silent over a failed *label* lookup. `Promise.allSettled` publishes
  // each independently, so the offer survives — under the only identifier
  // that outlived the failed lookup.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [],
    computeSnapshot: async () => [
      machine("rt_1", [env("crispr", "absent")]),
      machine("rt_2", [env("crispr", "absent")]),
    ],
    listMachines: async () => {
      throw new Error("names unavailable");
    },
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await user.click(await screen.findByRole("button", { name: /^Machine:/ }));
  const list = screen.getByRole("listbox", { name: "Machine" });
  expect(within(list).getByRole("option", { name: "rt_1" })).toBeVisible();
  expect(within(list).getByRole("option", { name: "rt_2" })).toBeVisible();

  await user.click(within(list).getByRole("option", { name: "rt_1" }));

  expect(
    await screen.findByRole("button", { name: "Set up crispr on rt_1" }),
  ).toBeInTheDocument();
});

it("says there is nowhere to build when no machine is paired with this lab", async () => {
  // The honest alternative to a button that cannot work. Nothing is paired,
  // so there is no machine to download a gigabyte onto — said plainly, rather
  // than offering a Set up that would fail on press.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [],
    computeSnapshot: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(barStatus()).toHaveTextContent("No machine is paired with this lab"),
  );
  expect(screen.queryByRole("button", { name: /^Set up/ })).not.toBeInTheDocument();
});

it("describes the build for the environment on screen and no other of this Task's", async () => {
  // A Task accumulates one durable job per environment it has ever asked for.
  // The bar is about the one being looked at, so another environment's failure
  // must not appear on it — and must appear the moment that environment is
  // the one selected.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr"), envDecl("spatial")],
    taskNotebook: async () => [],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("crispr", "absent"), env("spatial", "absent")]),
    ],
    taskEnvironmentSetups: async () => [
      setupFixture({ state: "building", stage: "installing" }),
      setupFixture({
        id: "job_2",
        environmentName: "spatial",
        state: "failed",
        stage: "resolving",
        errorSummary: "no candidate version for spatial",
      }),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(barStatus()).toHaveTextContent("Installing packages"));
  expect(screen.queryByText(/no candidate version for spatial/)).not.toBeInTheDocument();

  await user.click(envTrigger());
  await user.click(
    within(screen.getByRole("listbox", { name: "Kernel environment" })).getByRole(
      "option",
      { name: "spatial" },
    ),
  );

  await waitFor(() => expect(barStatus()).toHaveTextContent("Setup failed"));
  expect(screen.getByRole("alert")).toHaveTextContent("no candidate version for spatial");
});

it("reaches a declared environment no cell of this Task has used yet", async () => {
  // The list is the lab's declarations, not this notebook's history. An
  // environment a colleague declared and no cell here has run in is still the
  // one a researcher may want built, and this panel holds the only control
  // that builds one.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("crispr")],
    taskNotebook: async () => [cell({ name: "main", environment: "python" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("python", "ready"), env("crispr", "absent")]),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(barStatus()).toHaveTextContent("Ready"));

  await user.click(envTrigger());
  await user.click(
    within(screen.getByRole("listbox", { name: "Kernel environment" })).getByRole(
      "option",
      { name: "crispr" },
    ),
  );

  expect(
    await screen.findByRole("button", { name: "Set up crispr on rt_1" }),
  ).toBeInTheDocument();
});

it("keeps an unbuilt environment of another language selectable, so it can be built", async () => {
  // The lens is a lens, not a filter on the lab. An environment that was
  // never built can be in no cell, and this panel holds the only control that
  // builds one — scoped to the viewed language, a Task holding one Python
  // cell could not build this lab's `r` starter at all.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("r")],
    taskNotebook: async () => [
      cell({ name: "main", language: "python", environment: "python" }),
    ],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("python", "ready"), env("r", "absent")]),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(barStatus()).toHaveTextContent("Ready"));
  await user.click(envTrigger());
  await user.click(
    within(screen.getByRole("listbox", { name: "Kernel environment" })).getByRole(
      "option",
      { name: "r" },
    ),
  );

  expect(
    await screen.findByRole("button", { name: "Set up r on rt_1" }),
  ).toBeInTheDocument();
});

it("shows a Task's cells and its kernel while an environment it needs is still absent", async () => {
  // The environment a machine has yet to build and the kernels it is already
  // holding are two different facts. The gate is narrow on purpose: the
  // cells, their tabs and the kernel strip all describe kernels a machine is
  // already holding, and gating them on a missing environment would hide
  // every one of them behind a button that provisions an environment none of
  // them is in.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    // `crispr` leads the declarations, so it is what the bar opens on and the
    // outstanding build is the one on screen — which is the state this test
    // needs the cells and the kernel strip to survive.
    kernelEnvList: async () => [envDecl("crispr"), envDecl("python")],
    taskNotebook: async () => [
      cell({ name: "main", environment: "python", source: "import numpy as np" }),
      cell({ name: "main", environment: "crispr", source: "import scanpy" }),
    ],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("python", "ready"), env("crispr", "absent")]),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(barStatus()).toHaveTextContent("Setup needed"),
  );
  await waitFor(() => expect(screen.getByText("import numpy as np")).toBeInTheDocument());
  expect(screen.getByText("Main agent")).toBeInTheDocument();
  // `listRunningKernels` vouches for a kernel on this Task, so the status bar
  // says it is shared rather than that the namespace is gone.
  expect(screen.getByTestId("notebook-status")).toHaveTextContent(/Python/);
  expect(screen.getByTestId("notebook-status")).toHaveTextContent(/shared with the agent/);
});

it("does not claim a live kernel when none is running", async () => {
  // Cells prove code ran here once; an empty kernel list says nothing holds
  // that namespace now. The status bar must say the second thing, not the
  // first — claiming a shared namespace that no longer exists is the one
  // outright false sentence this surface could carry.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", source: "import numpy as np" })],
    listRunningKernels: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByText("import numpy as np")).toBeInTheDocument());
  const status = screen.getByTestId("notebook-status");
  expect(status).not.toHaveTextContent(/shared with the agent/);
  expect(status).toHaveTextContent(/view only — nothing is holding that namespace now/);
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
});

it("says nothing has run when the Task has neither cells nor kernels", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [],
    listRunningKernels: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(screen.getByTestId("notebook-cells")).toBeInTheDocument(),
  );
  // No language ever held this Task, so there is no fact for the bar to state
  // and it draws no line at all.
  expect(screen.queryByTestId("notebook-status")).not.toBeInTheDocument();
});

it("lists every environment this lab has declared, by name", async () => {
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("single-cell")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await user.click(await screen.findByRole("button", { name: /^Kernel environment:/ }));
  const list = screen.getByRole("listbox", { name: "Kernel environment" });
  expect(within(list).getByRole("option", { name: "python" })).toBeVisible();
  expect(within(list).getByRole("option", { name: "single-cell" })).toBeVisible();
  // No-mock-data: an R env is never invented — an option appears for an
  // environment once `kernelEnvList` reports it, and for no other.
  expect(within(list).queryByRole("option", { name: "r" })).not.toBeInTheDocument();
  expect(within(list).getAllByRole("option")).toHaveLength(2);
});

it("draws the same bar when the lab declares only one environment", async () => {
  // The bar is not a control that appears when there is a choice; it is the
  // line that says what this notebook runs in. One declaration is still an
  // answer to that, and a line that came and went with the number of
  // declarations would be one a researcher could not learn to look at.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  expect(
    await screen.findByRole("button", { name: "Kernel environment: python" }),
  ).toBeInTheDocument();
});

it("lists an environment of another language rather than hiding it behind the lens", async () => {
  renderPanel({
    envs: [
      { name: "python", language: "python", manager: "uv", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "r", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "rstats", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
    ],
    cells: [cell({ language: "r" })],
  });
  // Settled on the cell first: `shownLang` is null until the cells arrive, and
  // the selection this test reads is only the R one after they have.
  await screen.findByText("1 + 1");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Kernel environment: r" }));
  const list = screen.getByRole("listbox", { name: "Kernel environment" });
  expect(within(list).getByRole("option", { name: "r" })).toBeVisible();
  expect(within(list).getByRole("option", { name: "rstats" })).toBeVisible();
  // Present, not hidden: selecting it is the only route to building it.
  expect(within(list).getByRole("option", { name: "python" })).toBeVisible();
});

it("defaults to an environment of the viewed language, not merely the first declared", async () => {
  // THREE declarations, two of them R. The R cell must not open onto the
  // python environment because it happened to be declared first — `python`
  // leads the lab-wide list, and leading it is not an answer about R.
  renderPanel({
    envs: [
      { name: "python", language: "python", manager: "uv", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "r", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "rstats", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
    ],
    cells: [cell({ language: "r" })],
  });
  expect(
    await screen.findByRole("button", { name: "Kernel environment: r" }),
  ).toBeInTheDocument();
});

it("asks the server to build the R environment, not Python, when Set up runs under R", async () => {
  const user = userEvent.setup();
  const requestKernelEnvironmentSetup = vi.fn(async () => ({ jobId: "job_1" }));
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("r")],
    computeSnapshot: async () => [
      machine("rt_1", [env("python", "absent"), env("r", "absent")]),
    ],
    requestKernelEnvironmentSetup,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await user.click(await screen.findByRole("button", { name: /^Kernel environment:/ }));
  await user.click(
    within(screen.getByRole("listbox", { name: "Kernel environment" })).getByRole(
      "option",
      { name: "r" },
    ),
  );
  await user.click(await screen.findByRole("button", { name: "Set up r on rt_1" }));

  await waitFor(() =>
    // One machine is paired and nothing is holding a kernel, so that machine
    // is the one there is nothing to choose between. What this test is chiefly
    // about is the env NAME: a Set up under the R selection must ask for "r",
    // never the first declaration the list happens to lead with.
    expect(requestKernelEnvironmentSetup).toHaveBeenCalledWith({
      taskId: "tk_1",
      machineId: "rt_1",
      environmentName: "r",
    }),
  );
});

it("highlights each cell under its own language, not one hardcoded grammar", async () => {
  const cells: NotebookCell[] = [
    cell({ name: "main", source: "import numpy as np", language: "python", executionCount: 1 }),
    cell({ name: "main", source: "df <- read.csv('kinome.csv')", language: "r", executionCount: 2 }),
  ];
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => cells,
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
  };

  const { container } = render(
    <ApiProvider api={api}>
      <NotebookPanel taskId="tk_1" />
    </ApiProvider>,
  );

  // Each cell shows the language it actually ran under — `CodeBlock` renders
  // that label itself, so it is exactly what a researcher sees on the cell.
  // `waitFor` re-queries on every retry, unlike a single `findByText`, which
  // can resolve to a node CodeBlock's own async highlighter then replaces.
  await waitFor(() =>
    expect(screen.getByText("df <- read.csv('kinome.csv')")).toBeInTheDocument(),
  );
  // Scoped to the language chip specifically, not a text match: a cell's own
  // ENVIRONMENT is named "python" too, right beside its language, and so is
  // the kernel strip below the cell stack — an unscoped match over "python"
  // counts both of those on top of the cells that actually ran under it.
  const langs = [...container.querySelectorAll(".nbp-cell-lang")].map(
    (el) => el.textContent,
  );
  expect(langs).toEqual(["python", "r"]);
});

it("restarts the selected context's kernel", async () => {
  const user = userEvent.setup();
  const k = kernel({ name: "main", language: "python", state: "idle" });
  const kernelRestart = vi.fn(async (_kernelId: string): Promise<void> => {});
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [],
    listRunningKernels: async () => [k],
    kernelRestart,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  // Restart is on the status bar now, as text beside the fact it acts on.
  // It survived the dock's removal because it does something rather than
  // says something: a running kernel needs a way to be stopped.
  await user.click(await screen.findByRole("button", { name: "Restart" }));
  await waitFor(() => expect(kernelRestart).toHaveBeenCalledWith(k.id));
});

it("keeps rendering the Task when one output carries a shape this build does not know", async () => {
  // Outputs are stored as opaque JSON and come from a machine this browser
  // did not write. Reaching into a payload that is not there throws during
  // render, and a component that throws during render takes the whole Task
  // screen down — for everyone looking at it, over one cell's output.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [
      cell({
        name: "main",
        source: "surprise()",
        outputs: [
          { kind: "a kind from a later build" },
          { kind: "stream", name: "stdout", text: "still here\n" },
        ] as unknown as NotebookCell["outputs"],
      }),
    ],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByText("surprise()")).toBeInTheDocument());
  expect(screen.getByText(/still here/)).toBeInTheDocument();
});

it("opens on both languages in the order they ran, and narrows on request", async () => {
  // A context that writes Python and R owns two kernels, and the ledger is a
  // record of one session's work — so the order the work happened in is what
  // the panel OPENS on, and `All` is the resting state. A language is a lens
  // the researcher asks for: it narrows the ledger to that language's cells
  // and points the status bar at that language's kernel. `All` puts the rest
  // back, which is what keeps the narrowing from losing the record.
  const user = userEvent.setup();
  const py = kernel({ name: "main", language: "python", state: "idle" });
  const r = kernel({ name: "main", language: "r", state: "idle" });
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [
      cell({ name: "main", source: "import numpy as np", language: "python" }),
      cell({ name: "main", source: "library(ggplot2)", language: "r" }),
    ],
    listRunningKernels: async () => [py, r],
  };
  const { container } = render(
    <ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>,
  );

  // Read off each cell's own language marker rather than its source: the
  // highlighter splits code across token spans as soon as it resolves, so a
  // text match on the source is a race with it.
  const ledger = () =>
    [...container.querySelectorAll(".nbp-cell .nbp-cell-lang")].map((el) => el.textContent);

  // Nothing chosen: the whole record, interleaved.
  await waitFor(() => expect(ledger()).toEqual(["python", "r"]));

  await user.click(screen.getByRole("radio", { name: "R" }));

  await waitFor(() => expect(ledger()).toEqual(["r"]));
  // The kernel underneath is the one that was chosen.
  await waitFor(() =>
    expect(screen.getByTestId("notebook-status")).toHaveTextContent(/^R/),
  );

  // And back. One click returns everything the lens was hiding.
  await user.click(screen.getByRole("radio", { name: "All" }));
  await waitFor(() => expect(ledger()).toEqual(["python", "r"]));
});

it("keeps a language whose kernel has gone reachable, and says nothing holds it", async () => {
  // The chips come from the union of live kernels and the languages this
  // context's cells were run in. Built from live kernels alone, an R kernel
  // that expired would leave its own cells with no chip to ask for them by.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [
      cell({ name: "main", source: "import numpy as np", language: "python" }),
      cell({ name: "main", source: "library(ggplot2)", language: "r" }),
    ],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
  };
  const { container } = render(
    <ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>,
  );

  await user.click(await screen.findByRole("radio", { name: "R" }));

  // The R cell is still there to read, though nothing holds an R namespace.
  await waitFor(() =>
    expect(
      [...container.querySelectorAll(".nbp-cell .nbp-cell-lang")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["r"]),
  );
  const status = screen.getByTestId("notebook-status");
  expect(status).toHaveTextContent(/^R/);
  expect(status).toHaveTextContent(/view only — nothing is holding that namespace now/);
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
});

it("shows the R chip and the R cell from output a real R kernel produced", async () => {
  const recorded = recordedRCell as unknown as NotebookCell;
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [{ ...recorded, id: "cell_recorded", name: "main" }],
    listRunningKernels: async () => [
      kernel({ taskId: "task_r", name: "main", language: "python", state: "idle" }),
      kernel({ taskId: "task_r", name: "main", language: "r", state: "idle" }),
    ],
  };
  const { container } = render(
    <ApiProvider api={api}><NotebookPanel taskId="task_r" /></ApiProvider>,
  );

  const langs = await screen.findByTestId("notebook-langs");
  expect(within(langs).getByRole("radio", { name: "R" })).toBeInTheDocument();
  // The output the panel renders is the output the machine produced, not a
  // shape written by hand to match what the panel already did. Read off the
  // output region rather than the whole ledger: the cell's own source says
  // "hi" as well, and an assertion that source alone satisfies would go green
  // against a panel rendering no output at all.
  await waitFor(() =>
    expect(container.querySelector(".nbp-outputs")).toHaveTextContent(/hi/),
  );
  expect(container.querySelector(".nbp-outputs")).toHaveTextContent(/\[1\] 2/);
});

it("offers a way to end a cell while one is running", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "running" })],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  // The control a researcher needs is the one for the state they are in: with
  // a cell in flight that is how to end it, not how to start another.
  expect(await screen.findByRole("button", { name: "Interrupt" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
});

it("numbers a cell's lines so a traceback's line numbers resolve", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", source: "a = 1\nb = 2\nc = a + b" })],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
  };
  const { container } = render(
    <ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>,
  );

  await waitFor(() => expect(container.querySelector(".code-block--numbered")).not.toBeNull());
  // One numbered element per line, which is what the counter runs over.
  expect(container.querySelectorAll(".code-block--numbered .line")).toHaveLength(3);
});

it("names the researcher who ran a cell rather than their member id", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [
      cell({ name: "main", source: "df.shape", origin: { surface: "repl", by: "u_ana" } }),
    ],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
    listMembers: async () => [
      {
        user: {
          id: "u_ana",
          email: "ana@example.org",
          displayName: "Ana Ruiz",
          createdTs: 1,
        },
        role: "member",
        joinedTs: 1,
      },
    ] as unknown as ReturnType<LykeionApi["listMembers"]> extends Promise<infer M> ? M : never,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByText(/repl · Ana Ruiz/)).toBeInTheDocument());
  expect(screen.queryByText(/u_ana/)).not.toBeInTheDocument();
});

it("says which lens is empty rather than asking for cells that already exist", async () => {
  // A context with Python cells and an R kernel that has run none. Under the R
  // lens the ledger is empty, but the notebook is not — telling the researcher
  // to ask the agent to run something would be answering a question they did
  // not ask, and hiding the fact that All still has cells under it.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [
      cell({ name: "main", source: "import numpy as np", language: "python" }),
    ],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle" }),
      kernel({ name: "main", language: "r", state: "idle" }),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await user.click(await screen.findByRole("radio", { name: "R" }));

  await waitFor(() =>
    expect(screen.getByText(/No R cells in this context/)).toBeInTheDocument(),
  );
  expect(screen.queryByText(/Ask the agent to run code/)).not.toBeInTheDocument();

  await user.click(screen.getByRole("radio", { name: "All" }));
  await waitFor(() =>
    expect(screen.getByTestId("notebook-cells").querySelectorAll(".nbp-cell")).toHaveLength(1),
  );
});

/** A bystander under the same provider. The data version is the app-wide
 *  "read again" signal, and it is the only way to see an invalidation from
 *  outside the component that fired it — the panel's own poll never moves
 *  it, so a change here is a write's doing and nothing else's. */
function VersionProbe() {
  return <p data-testid="data-version">{useDataVersion()}</p>;
}

it("takes the setup state from the server rather than deriving one locally", async () => {
  // The whole of the ownership rule in one assertion. Nothing on this screen
  // pressed anything: the server holds a durable job for this Task, and the
  // bar says what that job says.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [],
    listRunningKernels: async () => [],
    computeSnapshot: async () => [machine("rt_1", [env("crispr", "absent")])],
    taskEnvironmentSetups: async () => [
      setupFixture({ state: "building", stage: "installing" }),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  expect(await screen.findByRole("status")).toHaveTextContent("Installing packages");
});

it("invalidates only once the setup command returns, and never guesses in between", async () => {
  // A Set up press asks the server and nothing else: no local flag flips the
  // bar to "building" while the request is still in the air. The app-wide read
  // signal moves when the command returns, and not a moment before.
  const user = userEvent.setup();
  const inFlight = deferred<{ jobId: string }>();
  const requestKernelEnvironmentSetup = vi.fn(async () => inFlight.promise);
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("crispr")],
    taskNotebook: async () => [],
    listRunningKernels: async () => [],
    computeSnapshot: async () => [machine("rt_1", [env("crispr", "absent")])],
    taskEnvironmentSetups: async () => [],
    requestKernelEnvironmentSetup,
  };
  render(
    <ApiProvider api={api}>
      <VersionProbe />
      <NotebookPanel taskId="tk_1" />
    </ApiProvider>,
  );

  const before = screen.getByTestId("data-version").textContent;
  await user.click(await screen.findByRole("button", { name: "Set up crispr on rt_1" }));

  await waitFor(() =>
    expect(requestKernelEnvironmentSetup).toHaveBeenCalledWith({
      taskId: "tk_1",
      machineId: "rt_1",
      environmentName: "crispr",
    }),
  );
  // Still the server's answer, unchanged: the press asked, it did not decide.
  expect(screen.getByRole("status")).toHaveTextContent("Setup needed");
  expect(screen.getByTestId("data-version")).toHaveTextContent(String(before));

  await act(async () => {
    inFlight.resolve({ jobId: "job_1" });
    await Promise.resolve();
  });

  await waitFor(() =>
    expect(screen.getByTestId("data-version")).not.toHaveTextContent(String(before)),
  );
});
