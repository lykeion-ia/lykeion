import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type KernelEnvStatus,
  type LykeionApi,
  type NotebookCell,
  type RunningKernel,
} from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { NotebookPanel as NotebookPanelUnderTest } from "./NotebookPanel";

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
    runtimeId: "rt_1",
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

const env = (name: string): KernelEnvStatus => ({
  state: "ready",
  platform: "macos-aarch64",
  root: `/x/envs/${name}`,
  name,
  language: name === "r" ? "r" : "python",
  manager: name === "python" ? "uv" : "conda",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  fireEvent.change(screen.getByLabelText(/Run Python on this kernel/i), {
    target: { value: "task_a_secret" },
  });
  expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();

  rerender(
    <ApiProvider api={api}><NotebookPanel taskId="task_b" /></ApiProvider>,
  );

  expect(screen.getByTestId("notebook-cells")).not.toHaveTextContent("task_a_secret = 42");
  expect(screen.queryByText(/Connected to the agent.s live kernel/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Run code on this kernel")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

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
  expect(screen.getByLabelText(/Run R on this kernel/i)).toBeInTheDocument();

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
  expect(screen.getByLabelText(/Run R on this kernel/i)).toBeInTheDocument();
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
  expect(screen.getByText(/Connected to the agent.s live kernel/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/Run Python on this kernel/i), {
    target: { value: "2 + 2" },
  });
  expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  expect(screen.queryByText(/Connected to the agent.s live kernel/)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Kernel status is unavailable. Code execution is disabled.",
  );
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByText(/Connected to the agent.s live kernel/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
});

it("names the language of the kernel it is showing", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listRunningKernels: async () => [kernel({ name: "main", language: "r", state: "idle" })],
    taskNotebook: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByTestId("notebook-strip")).toHaveTextContent(/R kernel/));
  expect(screen.getByTestId("notebook-strip")).not.toHaveTextContent(/Python kernel/);
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

it("shows the Setup state when the managed env isn't provisioned", async () => {
  // The in-memory core reports the honest first-install default (absent), so
  // the panel offers Setup.
  const api = createInMemoryApi();
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);
  await waitFor(() =>
    expect(screen.getByTestId("notebook-setup")).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: /Set up environment/i }),
  ).toBeInTheDocument();
});

it("shows a Task's cells, its kernel and its REPL while the managed env is still absent", async () => {
  // The environment a core has yet to provision and the kernels a machine is
  // already holding are two different facts. Every core in this build reports
  // `absent` and refuses to provision one, so a rail that waited for `ready`
  // would be a rail no researcher ever sees a cell in — and the button
  // offered instead cannot clear it.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", source: "import numpy as np" })],
    listRunningKernels: async () => [kernel({ name: "main", language: "python", state: "idle" })],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  expect(await screen.findByTestId("notebook-setup")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText("import numpy as np")).toBeInTheDocument());
  expect(screen.getByText("Main agent")).toBeInTheDocument();
  expect(screen.getByTestId("notebook-strip")).toHaveTextContent(/Python kernel/);
  expect(
    screen.getByRole("separator", { name: "Resize researcher console" }),
  ).toHaveAttribute("aria-valuenow", "128");
  expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
  // The one place this sentence is true: `listRunningKernels` vouches for a
  // kernel on this Task, so "connected" is a fact and not a mock-up.
  expect(screen.getByText(/Connected to the agent.s live kernel/)).toBeInTheDocument();
});

it("restores the default console height when the Notebook remounts", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", source: "import numpy as np" })],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle" }),
    ],
  };
  const { unmount } = render(
    <ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>,
  );

  const separator = await screen.findByRole("separator", {
    name: "Resize researcher console",
  });
  fireEvent.keyDown(separator, { key: "ArrowUp", shiftKey: true });
  expect(separator).toHaveAttribute("aria-valuenow", "192");

  unmount();
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);
  expect(
    await screen.findByRole("separator", { name: "Resize researcher console" }),
  ).toHaveAttribute("aria-valuenow", "128");
});

it("does not claim a live kernel when none is running", async () => {
  // Cells prove code ran here once; an empty kernel list says nothing holds
  // that namespace now. The greeting must say the second thing, not the
  // first — a "Connected" over a REPL nothing answers is the one outright
  // false sentence this surface could carry.
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main", source: "import numpy as np" })],
    listRunningKernels: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() => expect(screen.getByText("import numpy as np")).toBeInTheDocument());
  expect(screen.queryByText(/Connected to the agent.s live kernel/)).not.toBeInTheDocument();
  expect(screen.getByText(/nothing to run against/)).toBeInTheDocument();
  expect(screen.getByLabelText("Run code on this kernel")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});

it("says nothing has run when the Task has neither cells nor kernels", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [],
    listRunningKernels: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(screen.getByText(/Nothing has run code on this Task yet/)).toBeInTheDocument(),
  );
  expect(screen.queryByText(/Connected to the agent.s live kernel/)).not.toBeInTheDocument();
});

it("renders one sub-tab per environment, labeled by name", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [env("python"), env("single-cell")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);
  expect(
    await screen.findByRole("tab", { name: /python/i }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("tab", { name: /single-cell/i }),
  ).toBeInTheDocument();
});

it("renders a single tab when only one env exists (no hardcoded Python)", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [env("python")],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
  expect(screen.getByRole("tab", { name: /python/i })).toBeInTheDocument();
  // No-mock-data: an R env is never invented — the tab only appears once
  // kernelEnvList actually reports one.
  expect(screen.queryByRole("tab", { name: "r" })).not.toBeInTheDocument();
});

it("provisions the R env (not Python) when Setup runs from the R tab", async () => {
  const user = userEvent.setup();
  const kernelEnvSetup = vi.fn(
    async (
      name?: string,
      onProgress?: (line: string) => void,
    ): Promise<KernelEnvStatus> => {
      onProgress?.("provisioning…");
      return env(name ?? "python");
    },
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [env("python"), env("r")],
    kernelEnvSetup,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(screen.getByTestId("notebook-setup")).toBeInTheDocument(),
  );
  await user.click(await screen.findByRole("tab", { name: "r" }));
  await user.click(screen.getByRole("button", { name: /Set up environment/i }));
  await waitFor(() =>
    expect(kernelEnvSetup).toHaveBeenCalledWith("r", expect.any(Function)),
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

it("runs a REPL cell against the selected context's kernel", async () => {
  const user = userEvent.setup();
  const k = kernel({ name: "main", language: "python", state: "idle" });
  const kernelExecute = vi.fn(
    async (_kernelId: string, _code: string): Promise<{ cellId: string }> => ({
      cellId: "cell_x",
    }),
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [],
    listRunningKernels: async () => [k],
    kernelExecute,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  const input = await screen.findByLabelText(/Run Python on this kernel/i);
  await user.type(input, "np.pi");
  await user.click(screen.getByRole("button", { name: /^Run$/i }));
  await waitFor(() => expect(kernelExecute).toHaveBeenCalledWith(k.id, "np.pi"));
});

it("opens the exact researcher cell returned by execution when polling confirms it", async () => {
  vi.useFakeTimers();
  const k = kernel({ name: "main", language: "python", state: "idle" });
  const freshCell = cell({
    id: "fresh_cell",
    name: "main",
    source: "np.pi",
    outputs: [{ kind: "stream", name: "stdout", text: "3.14159\n" }],
  });
  const taskNotebook = vi
    .fn<LykeionApi["taskNotebook"]>()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([freshCell])
    .mockResolvedValueOnce([])
    .mockResolvedValue([freshCell]);
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook,
    listRunningKernels: async () => [k],
    kernelExecute: async () => ({ cellId: freshCell.id }),
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  fireEvent.change(screen.getByLabelText(/Run Python on this kernel/i), {
    target: { value: "np.pi" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });

  const firstDisclosure = screen.getByText(/^output/).closest("details");
  expect(firstDisclosure).toHaveAttribute("open");
  await act(async () => {
    fireEvent.click(screen.getByText(/^output/));
    await Promise.resolve();
  });
  expect(firstDisclosure).not.toHaveAttribute("open");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(screen.queryByText(/^output/)).not.toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(screen.getByText(/^output/).closest("details")).not.toHaveAttribute("open");
});

it("runs a cell against the R kernel once its context is active", async () => {
  const user = userEvent.setup();
  const rKernel = kernel({ name: "worker", language: "r", state: "idle" });
  const kernelExecute = vi.fn(
    async (_kernelId: string, _code: string): Promise<{ cellId: string }> => ({
      cellId: "cell_x",
    }),
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [],
    listRunningKernels: async () => [
      kernel({ name: "main", language: "python", state: "idle" }),
      rKernel,
    ],
    kernelExecute,
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await user.click(await screen.findByRole("tab", { name: /worker/i }));
  const input = await screen.findByLabelText(/Run R on this kernel/i);
  await user.type(input, "1 + 1");
  await user.click(screen.getByRole("button", { name: /^Run$/i }));
  await waitFor(() => expect(kernelExecute).toHaveBeenCalledWith(rKernel.id, "1 + 1"));
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

  // Restart lives behind the strip's own menu rather than as a standing
  // button: it is the control that throws away every variable in the
  // namespace, and it should take a deliberate second click to reach.
  await user.click(await screen.findByRole("button", { name: "Kernel actions" }));
  await user.click(await screen.findByRole("menuitem", { name: /Restart/i }));
  await waitFor(() => expect(kernelRestart).toHaveBeenCalledWith(k.id));
});

it("disables Run when the selected context has no kernel to execute against", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    taskNotebook: async () => [cell({ name: "main" })],
    listRunningKernels: async () => [],
  };
  render(<ApiProvider api={api}><NotebookPanel taskId="tk_1" /></ApiProvider>);

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Run$/i })).toBeDisabled(),
  );
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

it("keeps both languages' cells in the order they ran, and scopes only the kernel", async () => {
  // A context that writes Python and R owns two kernels, and the ledger is a
  // record of one session's work: choosing a language picks which kernel the
  // strip describes and the REPL runs in, and must NOT hide what the other
  // one did in between. The order the work happened in is the one thing a
  // record of it has to keep.
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

  await waitFor(() => expect(ledger()).toEqual(["python", "r"]));

  await user.click(screen.getByRole("radio", { name: "R" }));

  // Both still on screen, in the same order.
  expect(ledger()).toEqual(["python", "r"]);
  // The kernel underneath is the one that was chosen.
  await waitFor(() =>
    expect(screen.getByTestId("notebook-strip")).toHaveTextContent(/R kernel/),
  );
  expect(await screen.findByLabelText(/Run R on this kernel/i)).toBeInTheDocument();
});

it("keeps a language whose kernel has gone, and refuses to run against it", async () => {
  // The chips come from the union of live kernels and the languages this
  // context's cells were run in. Built from live kernels alone, an R kernel
  // that expired would take its own cells off the strip above them.
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

  // The R cell is still in the ledger, though nothing holds an R namespace.
  expect(
    [...container.querySelectorAll(".nbp-cell .nbp-cell-lang")].map((el) => el.textContent),
  ).toEqual(["python", "r"]);
  expect(screen.getByTestId("notebook-strip")).toHaveTextContent(/not running/);
  expect(screen.queryByText(/Connected to the agent.s live kernel/)).not.toBeInTheDocument();
  expect(screen.getByText(/Nothing is holding that namespace now/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
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
