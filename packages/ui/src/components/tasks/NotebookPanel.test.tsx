import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, render, screen, cleanup, waitFor, within } from "@testing-library/react";
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

it("shows a Task's cells and its kernel while the managed env is still absent", async () => {
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
