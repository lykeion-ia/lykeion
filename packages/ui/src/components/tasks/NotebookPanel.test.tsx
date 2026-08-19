import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type KernelEnvDeclaration,
  type KernelEnvState,
  type KernelEnvStatus,
  type LykeionApi,
  type MachineCompute,
  type NotebookCell,
  type RunningKernel,
  type Machine,
} from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
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
    studyId: "st_1",
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
 *  still what a machine reports and what `kernelEnvSetup` returns. */
const envDecl = (name: string): KernelEnvDeclaration => ({
  name,
  language: name === "r" ? "r" : "python",
  manager: name === "python" ? "uv" : "conda",
  packages: [],
  createdBy: "u_test",
  createdTs: 0,
  lockRevision: 0,
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
  expect(screen.getByRole("status")).toHaveTextContent(
    "Could not refresh the notebook. Showing the last confirmed cells.",
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
  expect(screen.getByRole("status")).toHaveTextContent(
    "Kernel status is unavailable. Code execution is disabled.",
  );
  expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

it("says what it is showing and how much of it", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({}), cell({})],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);
  await waitFor(() => expect(screen.getByTestId("notebook-footer")).toHaveTextContent("2 cells"));
});

it("offers Setup for the environment this Task's cells name that the machine lacks", async () => {
  // Two facts joined. The notebook's own cells say which environments this
  // Task needs; the machine holding its kernels says which of those it has
  // actually built. Setup is offered exactly where the two disagree — and
  // nowhere else, because an offer to rebuild what is already there asks a
  // researcher to spend a gigabyte on nothing.
  const api: LykeionApi = {
    ...createInMemoryApi(),
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

  expect(await screen.findByRole("button", { name: "Set up crispr" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set up python" })).not.toBeInTheDocument();
});

it("offers a re-provision for an environment the machine reports broken, and says so", async () => {
  // `broken` is a provision that began and was interrupted, and its own
  // documented remedy is to provision it again. Offered on `absent` alone,
  // the entire surface hides for it: no button, no sentence, no way forward
  // on the only screen in this product where building happens.
  //
  // And it is owed a sentence of its own rather than the absent one. "Has
  // never been built on this machine" is false about a copy that was built
  // and interrupted — it is a statement about the researcher's own machine
  // that they can see is wrong, on the surface asking them to trust it with
  // a gigabyte.
  const user = userEvent.setup();
  const kernelEnvSetup = vi.fn(
    async (
      _runtimeId: string,
      name: string,
      onProgress?: (line: string) => void,
    ): Promise<KernelEnvStatus> => {
      onProgress?.("provisioning…");
      return env(name);
    },
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1", [env("crispr", "broken")])],
    kernelEnvSetup,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  const rebuild = await screen.findByRole("button", { name: "Rebuild crispr" });
  const surface = screen.getByTestId("notebook-setup");
  expect(surface).toHaveTextContent(/was built on this machine and the build was interrupted/);
  expect(surface).not.toHaveTextContent(/never been built/);

  // One button, two sentences: the remedy is the same provision either way.
  await user.click(rebuild);
  await waitFor(() =>
    expect(kernelEnvSetup).toHaveBeenCalledWith("rt_1", "crispr", expect.any(Function)),
  );
});

it("says nothing about an environment the machine already holds", async () => {
  // The whole surface stays away, rather than appearing with nothing in it:
  // a Task whose every environment is built has no provisioning left to
  // describe.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", environment: "python" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1", [env("python", "ready")])],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByTestId("notebook-cells")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId("notebook-status")).toBeInTheDocument());
  expect(screen.queryByTestId("notebook-setup")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Set up/i })).not.toBeInTheDocument();
});

it("reads a machine with no environments field as one that has not reported", async () => {
  // Absent is not zero. A machine that has never told this lab what it holds
  // and a machine that told it "none" are different facts, and only the
  // second is something Setup can act on. Offering the build here would be
  // asking for a download on the strength of silence.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [machine("rt_1")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  expect(await screen.findByTestId("notebook-setup")).toHaveTextContent(
    /has not said which environments it holds/,
  );
  expect(screen.queryByRole("button", { name: /Set up/i })).not.toBeInTheDocument();
});

it("asks which machine should build when several are paired and no kernel names one", async () => {
  // A phase-4 ruling: inferring the machine would be this product silently
  // choosing which of a member's several paired computers downloads a
  // gigabyte. With no kernel running there is nothing here that knows, so
  // the researcher is asked rather than guessed at.
  const user = userEvent.setup();
  const kernelEnvSetup = vi.fn(
    async (
      _runtimeId: string,
      name: string,
      onProgress?: (line: string) => void,
    ): Promise<KernelEnvStatus> => {
      onProgress?.("provisioning…");
      return env(name);
    },
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [],
    computeSnapshot: async () => [
      machine("rt_1", [env("crispr", "absent")]),
      machine("rt_2", [env("crispr", "absent")]),
    ],
    listMachines: async () => [paired("rt_1", "laptop"), paired("rt_2", "workstation")],
    kernelEnvSetup,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  const asking = await screen.findByRole("group", { name: "Which machine" });
  expect(within(asking).getByRole("button", { name: "laptop" })).toBeInTheDocument();
  expect(within(asking).getByRole("button", { name: "workstation" })).toBeInTheDocument();
  // Nothing is chosen for them: until they say which, there is no build to
  // offer.
  expect(screen.queryByRole("button", { name: /Set up/i })).not.toBeInTheDocument();

  await user.click(within(asking).getByRole("button", { name: "workstation" }));

  await user.click(await screen.findByRole("button", { name: "Set up crispr" }));
  // The machine they chose, and not the first one in the list.
  await waitFor(() =>
    expect(kernelEnvSetup).toHaveBeenCalledWith("rt_2", "crispr", expect.any(Function)),
  );
});

it("asks which machine when this Task's kernels are running on two of them", async () => {
  // A running kernel names the machine this Task executes on — but only
  // where this Task's running kernels agree on one. Taking the first of two
  // would be the same silent pick the phase-4 ruling forbids, wearing a
  // running kernel as its excuse.
  const api: LykeionApi = {
    ...createInMemoryApi(),
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

  const asking = await screen.findByRole("group", { name: "Which machine" });
  expect(within(asking).getByRole("button", { name: "laptop" })).toBeInTheDocument();
  expect(within(asking).getByRole("button", { name: "workstation" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Set up/i })).not.toBeInTheDocument();
  // Asked about the silence they are actually in: two kernels running is not
  // "nothing is holding a kernel", and a researcher reading that sentence
  // with two of theirs running would rightly stop believing this surface.
  expect(screen.getByTestId("notebook-setup")).toHaveTextContent(
    /running on more than one of your machines/,
  );
});

it("still offers to build when listMachines fails, and names the machine by its raw id", async () => {
  // F2: `computeSnapshot` and `listMachines` used to share one `Promise.all`
  // and one `catch`, so a rejecting `listMachines` threw away a
  // `computeSnapshot` that had already succeeded and the whole build surface
  // went silent over a failed *label* lookup. `Promise.allSettled` publishes
  // each independently now, so the offer survives — with the id fallback at
  // `:298` standing in for the name this poll could never read.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
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

  const asking = await screen.findByRole("group", { name: "Which machine" });
  // No name could be read for either machine, so each is offered by the only
  // identifier that survived the failed lookup: its own runtime id.
  expect(within(asking).getByRole("button", { name: "rt_1" })).toBeInTheDocument();
  expect(within(asking).getByRole("button", { name: "rt_2" })).toBeInTheDocument();

  await user.click(within(asking).getByRole("button", { name: "rt_1" }));

  // The assertion that would have failed before the fix: a rejecting
  // `listMachines` left `machines` null under the old coupled `Promise.all`,
  // and this button never appeared at all.
  expect(await screen.findByRole("button", { name: "Set up crispr" })).toBeInTheDocument();
});

it("says there is nowhere to build when no machine is paired with this lab", async () => {
  // The honest alternative to a button that cannot work. Nothing is paired,
  // so there is no machine to download a gigabyte onto — said plainly,
  // rather than offering a Set up that would fail on press.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", environment: "crispr" })],
    listRunningKernels: async () => [],
    computeSnapshot: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  expect(await screen.findByTestId("notebook-setup")).toHaveTextContent(
    /No machine is paired with this lab, so there is nowhere to build an environment/,
  );
  expect(screen.queryByRole("button", { name: /Set up/i })).not.toBeInTheDocument();
});

it("says only the environment that is building is building", async () => {
  // A build belongs to the environment it provisions. Panel-wide, one build
  // put "Setting up…" on every other row and disabled it — every one of them
  // claiming to be doing something nobody asked it to do.
  const user = userEvent.setup();
  const inFlight = deferred<KernelEnvStatus>();
  const kernelEnvSetup = vi.fn(
    async (): Promise<KernelEnvStatus> => inFlight.promise,
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [
      cell({ name: "main", environment: "crispr" }),
      cell({ name: "main", environment: "spatial" }),
    ],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("crispr", "absent"), env("spatial", "absent")]),
    ],
    kernelEnvSetup,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await user.click(await screen.findByRole("button", { name: "Set up crispr" }));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Setting up…" })).toBeDisabled(),
  );
  // The one nobody pressed is neither building nor out of reach.
  const other = screen.getByRole("button", { name: "Set up spatial" });
  expect(other).toBeEnabled();

  await act(async () => {
    inFlight.resolve(env("crispr"));
    await Promise.resolve();
  });
});

it("reaches a declared environment no cell of this Task has used yet", async () => {
  // The chip row is the only control that can add a name to the set this
  // Task needs. Rendered inside the Setup surface it appeared only where an
  // offer already existed, so an environment a colleague declared and no
  // cell here has used could never be selected — and therefore never built,
  // on the only screen in this product where building happens.
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

  // Nothing to offer: every environment this Task has actually used is
  // built. The row is still reachable, which is the whole point.
  const chip = await screen.findByRole("tab", { name: "crispr" });
  expect(screen.queryByTestId("notebook-setup")).not.toBeInTheDocument();

  await user.click(chip);

  expect(await screen.findByRole("button", { name: "Set up crispr" })).toBeInTheDocument();
});

it("keeps an unbuilt environment of another language selectable, so it can be built", async () => {
  // The picker shows one language at a time, and it is also the only route
  // to `kernelEnvSetup` — the single call in this product that builds
  // anything. Scoped to the viewed language alone, those two facts combine
  // into a trap: an environment that was never built can be in no cell,
  // `neededEnvs` is cells plus the selection, so a Task holding one Python
  // cell could not build the lab's `r` starter from the only screen that
  // builds. Offering it costs nothing — a cell naming an environment this
  // machine lacks is refused by name either way.
  const user = userEvent.setup();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("r")],
    taskNotebook: async () => [cell({ name: "main", language: "python", environment: "python" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("python", "ready"), env("r", "absent")]),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  // Offered even though this notebook is being viewed as Python and holds no
  // R cell — because it is not built here.
  const chip = await screen.findByRole("tab", { name: "r" });
  await user.click(chip);

  expect(await screen.findByRole("button", { name: "Set up r" })).toBeInTheDocument();
});

it("drops an environment of another language from the picker once it is built", async () => {
  // The other half, and what keeps the rule above from undoing the language
  // scoping entirely: an environment that EXISTS here is a real cell target
  // in its own language and a guaranteed refusal in any other, so once it is
  // built it goes back to being none of a Python notebook's business.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("r")],
    taskNotebook: async () => [cell({ name: "main", language: "python", environment: "python" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle", machineId: "rt_1" }),
    ],
    computeSnapshot: async () => [
      machine("rt_1", [env("python", "ready"), env("r", "ready")]),
    ],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  // Settled on the CELL, not on the Setup surface: with everything built
  // there is nothing to set up, so that surface never appears here and
  // waiting for it would time out. Asserting the absence before the panel
  // loads would pass against any implementation at all.
  await screen.findByText("1 + 1");
  expect(screen.queryByRole("tab", { name: "r" })).not.toBeInTheDocument();
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

  expect(await screen.findByTestId("notebook-setup")).toBeInTheDocument();
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

it("renders one sub-tab per environment, labeled by name", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("single-cell")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);
  expect(
    await screen.findByRole("tab", { name: /python/i }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("tab", { name: /single-cell/i }),
  ).toBeInTheDocument();
  // No-mock-data: an R env is never invented — a chip appears for an
  // environment once kernelEnvList actually reports it, and for no other.
  expect(screen.queryByRole("tab", { name: "r" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
});

it("draws no environment row when the lab declares only one (nothing to choose)", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  // The surface below it still speaks — this panel has something to say
  // about that one environment either way.
  await waitFor(() => expect(screen.getByTestId("notebook-setup")).toBeInTheDocument());
  // One declaration is not a choice: it is already the selected one, so a
  // permanent row for it would spend a line of a dense, keyboard-first panel
  // on a control with nothing to do.
  expect(screen.queryByRole("tablist", { name: "Kernel environment" })).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
});

it("offers only environments of the language being viewed", async () => {
  renderPanel({
    envs: [
      { name: "python", language: "python", manager: "uv", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "r", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "rstats", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
    ],
    cells: [cell({ language: "r" })],
  });
  // Settled first. `shownLang` is null until the cells arrive, and with no
  // language to scope by the picker legitimately shows the whole lab-wide
  // list for that moment — so a `findByRole` that resolves on the tablist's
  // first appearance can read the pre-settle state and see `python`. Under a
  // full-suite load that is not hypothetical: it is how this test failed
  // once before being written this way.
  //
  // Anchored on the CELL rather than on the Setup surface, because these
  // fixtures build everything: with nothing to set up, that surface never
  // renders and waiting for it only times out.
  await screen.findByText("1 + 1");
  const picker = await screen.findByRole("tablist", { name: "Kernel environment" });
  expect(within(picker).getByRole("tab", { name: "r" })).toBeInTheDocument();
  expect(within(picker).getByRole("tab", { name: "rstats" })).toBeInTheDocument();
  await waitFor(() =>
    expect(within(picker).queryByRole("tab", { name: "python" })).not.toBeInTheDocument(),
  );
});

it("defaults to an environment of the viewed language, not merely the first declared", async () => {
  // THREE declarations, two of them R, and the third is not decoration: the
  // picker only renders where the viewed language has something to choose
  // between, so a fixture of one-per-language hides the very control this
  // assertion reads. The default is only observable where a choice exists.
  renderPanel({
    envs: [
      { name: "python", language: "python", manager: "uv", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "r", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "rstats", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
    ],
    cells: [cell({ language: "r" })],
  });
  // The R cell must not open onto the python environment because it happened
  // to be declared first — `python` leads the lab-wide list and led the
  // selection before this change.
  expect(await screen.findByRole("tab", { name: "r", selected: true })).toBeInTheDocument();
});

it("hides the picker when the viewed language has only one environment", async () => {
  renderPanel({
    envs: [
      { name: "python", language: "python", manager: "uv", packages: [], createdTs: 0, lockRevision: 1 },
      { name: "r", language: "r", manager: "conda", packages: [], createdTs: 0, lockRevision: 1 },
    ],
    cells: [cell({ language: "python" })],
  });
  // Awaited BEFORE the absence is asserted, and that is the whole of whether
  // this test says anything: `queryBy` on a panel that has not finished
  // loading finds nothing whatever the code does, so the first draft of this
  // passed identically against the unfixed component.
  //
  // Both environments are BUILT here, which the fixture now says out loud.
  // Left unbuilt, `r` is offered in the picker however the language lens is
  // set — that is the only way to build one — and whether this assertion saw
  // it depended on when the compute snapshot landed. It passed on timing and
  // failed in the public repo's gate.
  await screen.findByText("1 + 1");
  // Two declared, one per language: a control with nothing to choose between
  // is not a control. This is the gate that has never rendered until now.
  expect(screen.queryByRole("tablist", { name: "Kernel environment" })).not.toBeInTheDocument();
});

it("provisions the R env (not Python) when Setup runs from the R tab", async () => {
  const user = userEvent.setup();
  const kernelEnvSetup = vi.fn(
    async (
      _runtimeId: string,
      name: string,
      onProgress?: (line: string) => void,
    ): Promise<KernelEnvStatus> => {
      onProgress?.("provisioning…");
      return env(name);
    },
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [envDecl("python"), envDecl("r")],
    computeSnapshot: async () => [
      machine("rt_1", [env("python", "absent"), env("r", "absent")]),
    ],
    kernelEnvSetup,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(screen.getByTestId("notebook-setup")).toBeInTheDocument(),
  );
  await user.click(await screen.findByRole("tab", { name: "r" }));
  await user.click(await screen.findByRole("button", { name: "Set up r" }));
  await waitFor(() =>
    // One machine is paired and nothing is holding a kernel, so that machine
    // is the one there is nothing to choose between — the id it is asked
    // under is real, not a placeholder. What this test is chiefly about is
    // the env NAME: the R tab's own setup must ask for "r", never the
    // hardcoded "python" this bug used to send regardless of which tab was
    // selected.
    expect(kernelEnvSetup).toHaveBeenCalledWith("rt_1", "r", expect.any(Function)),
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

  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  // Each cell shows the language it actually ran under — `CodeBlock` renders
  // that label itself, so it is exactly what a researcher sees on the cell.
  // `waitFor` re-queries on every retry, unlike a single `findByText`, which
  // can resolve to a node CodeBlock's own async highlighter then replaces.
  await waitFor(() =>
    expect(screen.getByText("df <- read.csv('kinome.csv')")).toBeInTheDocument(),
  );
  // Scoped to the cell stack: the kernel strip below it names the ENVIRONMENT
  // a kernel runs in, and an environment is called "python" too — an
  // unscoped match counts that as a third cell.
  const langs = within(screen.getByTestId("notebook-cells"))
    .getAllByText(/^(python|r)$/)
    .map((el) => el.textContent);
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
