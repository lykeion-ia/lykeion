import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type KernelEnvStatus,
  type Language,
  type LykeionApi,
  type NotebookCell,
  type NotebookStatus,
} from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { NotebookPanel } from "./NotebookPanel";

afterEach(cleanup);

it("shows the Setup state when the managed env isn't provisioned", async () => {
  // The in-memory core reports the honest first-install default (absent), so
  // the panel offers Setup rather than a live REPL — nothing faked.
  const api = createInMemoryApi();
  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("notebook-setup")).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: /Set up environment/i }),
  ).toBeInTheDocument();
});

it("renders the shared-kernel cells and runs a REPL cell", async () => {
  const user = userEvent.setup();
  const status: NotebookStatus = {
    envReady: true,
    launched: true,
    state: "idle",
    executionCount: 3,
  };
  const cells: NotebookCell[] = [
    {
      executionCount: 3,
      source: "import numpy as np",
      surface: "agent",
      language: "python",
      ok: true,
      wallMs: 4,
      ts: 1,
      outputs: [{ kind: "stream", name: "stdout", text: "loaded\n" }],
    },
  ];
  const kernelExecute = vi.fn(
    async (
      _studyId: string,
      code: string,
      _language?: Language,
    ): Promise<NotebookCell> => ({
      executionCount: 4,
      source: code,
      surface: "notebook",
      language: "python",
      ok: true,
      wallMs: 2,
      ts: 2,
      outputs: [],
    }),
  );

  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelStatus: async () => status,
    kernelDocument: async () => cells,
    kernelExecute,
  };

  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );

  // The agent's cell shows, along with the shared-kernel strip.
  await waitFor(() =>
    expect(screen.getByText("import numpy as np")).toBeInTheDocument(),
  );
  const strip = screen.getByTestId("notebook-strip");
  expect(strip).toHaveTextContent(/shared with the agent/i);
  expect(strip).toHaveTextContent("In [3]");
  expect(strip).toHaveTextContent("idle");

  // Running a REPL cell forwards code to the shared kernel.
  await user.type(
    screen.getByLabelText(/Run Python on the shared kernel/i),
    "np.pi",
  );
  await user.click(screen.getByRole("button", { name: /^Run$/i }));
  await waitFor(() =>
    // The active tab (no envs registered here, so the Python-only default
    // applies) selects the language threaded through to the shared kernel.
    expect(kernelExecute).toHaveBeenCalledWith("st_1", "np.pi", "python"),
  );
});

it("the activity meter reflects the kernel state", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelStatus: async (): Promise<NotebookStatus> => ({
      envReady: true,
      launched: true,
      state: "busy",
      executionCount: 1,
    }),
    kernelDocument: async () => [],
  };
  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );
  const meter = await screen.findByTestId("notebook-meter");
  // The live-activity indicator: sweeping while the kernel is busy.
  await waitFor(() => expect(meter.className).toContain("nbp-meter--busy"));
});

const env = (name: string): KernelEnvStatus => ({
  state: "ready",
  platform: "macos-aarch64",
  root: `/x/envs/${name}`,
  name,
  manager: name === "python" ? "uv" : "conda",
});

it("renders one sub-tab per environment, labeled by name", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [env("python"), env("single-cell")],
  };
  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );
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
  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
  expect(screen.getByRole("tab", { name: /python/i })).toBeInTheDocument();
  // No-mock-data: an R env is never invented — the tab only appears once
  // kernelEnvList actually reports one.
  expect(screen.queryByRole("tab", { name: "r" })).not.toBeInTheDocument();
});

it("selects the R tab's language for status once an R env exists", async () => {
  const user = userEvent.setup();
  const statusFor = (language?: Language): NotebookStatus => ({
    envReady: language === "r",
    launched: language === "r",
    state: "idle",
    executionCount: 0,
  });
  const kernelStatus = vi.fn(
    async (_studyId: string, language?: Language): Promise<NotebookStatus> =>
      statusFor(language),
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [env("python"), env("r")],
    kernelStatus,
    kernelDocument: async () => [],
  };
  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );

  // Initial (Python) status read, then the R tab drives a fresh one.
  await waitFor(() =>
    expect(kernelStatus).toHaveBeenCalledWith("st_1", "python"),
  );
  await user.click(await screen.findByRole("tab", { name: "r" }));
  await waitFor(() => expect(kernelStatus).toHaveBeenCalledWith("st_1", "r"));
});

it("runs a cell against the R kernel once the R tab is active", async () => {
  const user = userEvent.setup();
  const kernelStatus = vi.fn(
    async (_studyId: string, language?: Language): Promise<NotebookStatus> => ({
      envReady: language === "r",
      launched: language === "r",
      state: "idle",
      executionCount: 0,
    }),
  );
  const kernelExecute = vi.fn(
    async (
      _studyId: string,
      code: string,
      language?: Language,
    ): Promise<NotebookCell> => ({
      executionCount: 1,
      source: code,
      surface: "notebook",
      language: language ?? "python",
      ok: true,
      wallMs: 2,
      ts: 2,
      outputs: [],
    }),
  );
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [env("python"), env("r")],
    kernelStatus,
    kernelDocument: async () => [],
    kernelExecute,
  };
  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );

  await user.click(await screen.findByRole("tab", { name: "r" }));
  // The R env reports ready, so the REPL (not Setup) renders.
  const input = await screen.findByLabelText(/Run R on the shared kernel/i);
  await user.type(input, "1 + 1");
  await user.click(screen.getByRole("button", { name: /^Run$/i }));
  await waitFor(() =>
    expect(kernelExecute).toHaveBeenCalledWith("st_1", "1 + 1", "r"),
  );
});

it("provisions the R env (not Python) when Setup runs from the R tab", async () => {
  const user = userEvent.setup();
  // Python is ready, R is not — so the R tab (and only the R tab) shows
  // Setup, exercising the bug this fix closes: Setup used to always
  // provision Python regardless of which tab triggered it.
  const kernelStatus = vi.fn(
    async (_studyId: string, language?: Language): Promise<NotebookStatus> => ({
      envReady: language !== "r",
      launched: language !== "r",
      state: "idle",
      executionCount: 0,
    }),
  );
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
    kernelStatus,
    kernelDocument: async () => [],
    kernelEnvSetup,
  };
  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );

  await user.click(await screen.findByRole("tab", { name: "r" }));
  await waitFor(() =>
    expect(screen.getByTestId("notebook-setup")).toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: /Set up environment/i }));
  await waitFor(() =>
    expect(kernelEnvSetup).toHaveBeenCalledWith("r", expect.any(Function)),
  );
});

/**
 * A mixed-language document renders each cell under ITS OWN grammar.
 *
 * The notebook is one document per Study and a Study can run a Python and an R
 * kernel side by side, so `NotebookCell.language` is per CELL. The panel already
 * routed EXECUTION by it (`kernelExecute(studyId, code, language)`) while the
 * renderer hardcoded `lang="python"` — so an R cell was run on the R kernel,
 * labelled R in the REPL, and then syntax-highlighted as Python.
 */
it("highlights each cell under its own language, not one hardcoded grammar", async () => {
  const cells: NotebookCell[] = [
    {
      executionCount: 1,
      source: "import numpy as np",
      surface: "agent",
      language: "python",
      ok: true,
      wallMs: 4,
      ts: 1,
      outputs: [],
    },
    {
      executionCount: 2,
      source: "df <- read.csv('kinome.csv')",
      surface: "notebook",
      language: "r",
      ok: true,
      wallMs: 6,
      ts: 2,
      outputs: [],
    },
  ];
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelStatus: async () => ({
      envReady: true,
      launched: true,
      state: "idle" as const,
      executionCount: 2,
    }),
    kernelDocument: async () => cells,
  };

  render(
    <ApiProvider api={api}>
      <NotebookPanel studyId="st_1" />
    </ApiProvider>,
  );

  // Each cell shows the language it actually ran under — `CodeBlock` renders
  // that label itself, so it is exactly what a researcher sees on the cell.
  expect(await screen.findByText("df <- read.csv('kinome.csv')")).toBeInTheDocument();
  const langs = screen
    .getAllByText(/^(python|r)$/)
    .map((el) => el.textContent);
  expect(langs).toEqual(["python", "r"]);
});
