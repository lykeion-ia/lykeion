import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render as rtlRender, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type KernelEnvDeclaration,
  type KernelEnvStatus,
  type LykeionApi,
  type Machine,
  type RunningKernel,
} from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { MachinesList } from "./MachinesList";

afterEach(cleanup);

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: "rt_1",
    name: "ana-macbook",
    ownerId: "u_you",
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    health: "online",
    lastSeenTs: 1_700_000_000,
    capabilities: [],
    ...overrides,
  };
}

/** Every test below renders through this rather than `@testing-library/react`'s
 *  own `render` directly: `MachinesList` calls `useApi()` unconditionally, so
 *  a tree with no `ApiProvider` above it throws before anything renders,
 *  whether or not a given test ever exercises a control that reaches the
 *  api. */
function render(ui: ReactElement) {
  const api: LykeionApi = createInMemoryApi();
  return rtlRender(<ApiProvider api={api}>{ui}</ApiProvider>);
}

function renderList(
  machines: Machine[],
  meId: string | null,
  apiOverrides: Partial<LykeionApi> = {},
) {
  const api: LykeionApi = { ...createInMemoryApi(), ...apiOverrides };
  return rtlRender(
    <ApiProvider api={api}>
      <MachinesList machines={machines} meId={meId} />
    </ApiProvider>,
  );
}

/** The baseline props every new test below starts from: one machine, owned
 *  by the caller, so `compute`'s `rt_1` entries land on a row that is
 *  actually on screen. */
const props = { machines: [machine()], meId: "u_you" };

/** A minimal, valid `RunningKernel` to spread and override — everything
 *  `toRunningKernel` requires, none of what a particular test cares about. */
const kernel: RunningKernel = {
  id: "k_0",
  sessionId: "sess_1",
  taskId: "t_1",
  name: "main",
  language: "python",
  machineId: "rt_1",
  studyId: "study_1",
  state: "idle",
  incarnation: 1,
  executionCount: 0,
  queueDepth: 0,
  environment: "python",
};

it("names the machine, its platform and its health", () => {
  renderList([machine()], "u_you");
  expect(screen.getByText("ana-macbook")).toBeInTheDocument();
  expect(screen.getByText("macos-aarch64")).toBeInTheDocument();
  expect(screen.getByText(/online/i)).toBeInTheDocument();
});

it("lists every machine in the lab on one roster, the caller's own first", () => {
  renderList(
    [
      machine({ id: "rt_2", name: "bo-workstation", ownerId: "u_bo" }),
      machine(),
    ],
    "u_you",
  );
  const roster = screen.getByRole("list", { name: "Lab's machines" });
  expect(within(roster).getByText("ana-macbook")).toBeInTheDocument();
  expect(within(roster).getByText("bo-workstation")).toBeInTheDocument();
  // Ordered rather than merely present: the machines a researcher can act on
  // read first, even when the lab hands them back the other way round.
  const names = within(roster)
    .getAllByRole("listitem")
    .map((row) => row.textContent ?? "");
  expect(names.findIndex((t) => t.includes("ana-macbook"))).toBeLessThan(
    names.findIndex((t) => t.includes("bo-workstation")),
  );
});

it("carries no heading over the roster, and still announces the list as one of machines", () => {
  renderList(
    [machine(), machine({ id: "rt_2", name: "bo-workstation", ownerId: "u_bo" })],
    "u_you",
  );

  // Nothing titles the roster on screen — not the heading the yours/theirs
  // split used to carry, and not the merged one that replaced it.
  expect(screen.queryByRole("heading", { name: "Your machines" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Lab's machines" })).toBeNull();

  // The name survives where it costs nothing to see: with no visible title
  // to repeat, an `aria-label` duplicates nothing, and the alternative is a
  // list of machines that announces as an unnamed list.
  const roster = screen.getByRole("list", { name: "Lab's machines" });
  expect(roster.getAttribute("aria-label")).toBe("Lab's machines");
  expect(roster.getAttribute("aria-labelledby")).toBeNull();
});

it("carries the command itself, addressed to this lab, and promises nothing it cannot do", () => {
  renderList([], "u_you");

  const card = screen.getByRole("heading", { name: "Add your first machine" }).closest("section");
  expect(card).not.toBeNull();
  // A file name is not somewhere a browser can go, so the card has to carry
  // the command itself — filled in with this lab's own address, which is the
  // one part a researcher could not supply from where they are standing.
  expect(card).toHaveTextContent(`pnpm daemon --lab ${window.location.origin}`);
  // Nothing can pick up a task on this build, and the composer says so on
  // the screens that host it. This card says nothing about it either way,
  // which is the one thing it must not get wrong in the other direction.
  expect(card).not.toHaveTextContent(/queued task/i);
});

it("offers the command to be taken, not only to be read", () => {
  // It is meant to be run on the machine being added, which is often not the
  // one reading this — so it is copied far more often than typed.
  renderList([], "u_you");

  expect(
    screen.getByRole("button", { name: "Copy the command" }),
  ).toBeInTheDocument();
});

it("says a browser tab is coming, because nothing else will", () => {
  // The step the flow was missing. Pairing hands off to a page the daemon
  // serves on the machine itself, and the lab cannot link to it — the port
  // is whatever was free and the link carries a single-use nonce. So the
  // one thing the lab can do is say it is about to happen; otherwise a tab
  // opens, from a command typed in a terminal, and reads as unrelated.
  renderList([], "u_you");

  const card = screen.getByRole("heading", { name: "Add your first machine" }).closest("section");
  expect(card).toHaveTextContent(/setup page opens in your browser/i);
  expect(card).toHaveTextContent(/approve the request back here/i);
});

it("steps out of the way once the member has a machine of their own", () => {
  // Someone with a machine came for the roster. The same card left open is
  // the loudest thing on a page whose subject is now the table above it.
  renderList([machine({ ownerId: "u_you" })], "u_you");

  expect(screen.queryByText("Add your first machine")).toBeNull();
  expect(screen.queryByText(/setup page opens in your browser/i)).toBeNull();
  // Still reachable — a second machine is a real thing to want.
  expect(screen.getByRole("button", { name: "Add a machine" })).toBeInTheDocument();
});

it("reopens the steps on request, for a second machine", async () => {
  const user = userEvent.setup();
  renderList([machine({ ownerId: "u_you" })], "u_you");

  await user.click(screen.getByRole("button", { name: "Add a machine" }));

  // Not "your first" this time: the wording follows what is actually true.
  expect(
    screen.getByRole("heading", { name: "Add a machine" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/setup page opens in your browser/i)).toBeInTheDocument();
});

it("keeps asking a member whose colleagues have machines but who has none", () => {
  // Machines are owned, and only the member who paired one can run on it.
  renderList([machine({ ownerId: "u_them" })], "u_you");

  expect(screen.getByText("Add your first machine")).toBeInTheDocument();
});

it("offers Remove on your own machine and on none of the lab's others", () => {
  renderList(
    [machine(), machine({ id: "rt_2", name: "bo-workstation", ownerId: "u_bo" })],
    "u_you",
  );
  // One roster now holds both, so which row offers Remove is the only thing
  // separating them — the privacy rule has to hold on ownership alone, with
  // no heading left to carry it.
  const roster = screen.getByRole("list", { name: "Lab's machines" });
  expect(
    within(roster).getByRole("button", { name: /Remove ana-macbook/i }),
  ).toBeInTheDocument();
  expect(
    within(roster).queryByRole("button", { name: /Remove bo-workstation/i }),
  ).toBeNull();
});

it("asks for confirmation before calling removeMachine, and stays quiet on Cancel", async () => {
  const user = userEvent.setup();
  const removeMachine = vi.fn().mockResolvedValue(undefined);
  renderList([machine()], "u_you", { removeMachine });

  await user.click(screen.getByRole("button", { name: /Remove ana-macbook/i }));
  const dialog = await screen.findByRole("dialog", { name: /remove machine/i });
  expect(removeMachine).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(removeMachine).not.toHaveBeenCalled();
});

it("calls removeMachine with the machine's id once the confirmation is confirmed", async () => {
  const user = userEvent.setup();
  const removeMachine = vi.fn().mockResolvedValue(undefined);
  renderList([machine()], "u_you", { removeMachine });

  await user.click(screen.getByRole("button", { name: /Remove ana-macbook/i }));
  const dialog = await screen.findByRole("dialog", { name: /remove machine/i });
  await user.click(within(dialog).getByRole("button", { name: /^remove$/i }));

  expect(removeMachine).toHaveBeenCalledWith("rt_1");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the confirmation open and shows the failure when removeMachine rejects", async () => {
  const user = userEvent.setup();
  const removeMachine = vi.fn().mockRejectedValue(new Error("machine already gone"));
  renderList([machine()], "u_you", { removeMachine });

  await user.click(screen.getByRole("button", { name: /Remove ana-macbook/i }));
  const dialog = await screen.findByRole("dialog", { name: /remove machine/i });
  await user.click(within(dialog).getByRole("button", { name: /^remove$/i }));

  expect(await screen.findByText(/machine already gone/i)).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: /remove machine/i })).toBeInTheDocument();
});

it("shows what a machine's kernels are holding, against what it has", () => {
  render(<MachinesList {...props} compute={[{
    machineId: "rt_1",
    memoryBytes: 15_728_640,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    cpuPercent: 0,
    cores: 8,
  }]} />);
  expect(screen.getByText("15.0 MB of 8.0 GB")).toBeInTheDocument();
  expect(screen.getByText("0.0 of 8 cores")).toBeInTheDocument();
});

it("renders an em dash on both figures for a machine that reported none, and a zero on neither", () => {
  render(<MachinesList {...props} compute={[{ machineId: "rt_1" }]} />);
  // Both cells, counted rather than merely non-empty: a machine row has two
  // figures on it, and `getAllByText("—").length > 0` was satisfied by
  // either one of them alone — so it passed with the other rendering
  // anything at all, including a zero.
  expect(screen.getAllByText("—")).toHaveLength(2);
  // The half that was missing entirely, and the one `KernelTree`'s own em
  // dash test already asserts for a kernel row: a figure nobody could
  // measure must not read as one measured at nothing.
  expect(screen.queryByText(/0 B/)).toBeNull();
  expect(screen.queryByText(/0\.0 of/)).toBeNull();
});

it("draws a machine's shape over time against the machine, never against its own peak", () => {
  // The call site, which nothing queried: `Sparkline`'s own suite pins that
  // it honours the ceiling it is handed, and this pins which ceiling this
  // row hands it. Auto-scaling — every library's default, and the thing the
  // component exists to refuse — would draw these three readings as
  // "▁▄█" and tell a researcher a machine holding 4 MB of 8 GB is full.
  render(
    <MachinesList
      {...props}
      compute={[
        {
          machineId: "rt_1",
          totalMemoryBytes: 8 * 1024 * 1024 * 1024,
          cores: 8,
          series: [
            { memoryBytes: 1024 * 1024, cpuPercent: 1 },
            { memoryBytes: 2 * 1024 * 1024, cpuPercent: 2 },
            { memoryBytes: 4 * 1024 * 1024, cpuPercent: 4 },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByLabelText("Memory over time").textContent).toBe("▁▁▁");
  expect(screen.getByLabelText("Processor over time").textContent).toBe("▁▁▁");
});

it("says which requirement a machine is missing when it cannot host a kernel", () => {
  renderList(
    [machine({ kernelsReason: "uv is not installed, and Lykeion starts kernels with it" })],
    "u_you",
  );
  expect(
    screen.getByText(/uv is not installed, and Lykeion starts kernels with it/),
  ).toBeInTheDocument();
});

it("says nothing about the kernel floor for a machine that can host one", () => {
  renderList([machine({ capabilities: ["kernels"] })], "u_you");
  expect(screen.queryByText(/cannot host kernels/i)).toBeNull();
});

it("carries no column of its own for what is installed on a machine", () => {
  // The per-machine agent list below this roster answers it in full —
  // installed and not, with versions and sign-in state — and a cell here said
  // a worse version of the same thing beside it. Asserted on the column head
  // rather than on a row, because a header is what makes a column a column.
  const roster = () => screen.getByRole("list", { name: "Lab's machines" });
  renderList([machine()], "u_you");
  expect(within(roster()).queryByText("CLIs")).toBeNull();
});

it("keeps what a machine is holding, and what stops it holding anything, under its name", () => {
  // Both used to ride along in the CLIs cell without being about its subject,
  // so taking that column out is exactly where they could have been lost.
  // Asserted against the name cell rather than the document: the summary is
  // also rendered inside the kernel tree a row opens onto, and a bare
  // `getByText` would pass on that copy alone with this cell empty.
  renderList(
    [machine({ kernelsReason: "uv is not installed, and Lykeion starts kernels with it" })],
    "u_you",
  );
  const idle = screen.getByText("ana-macbook").parentElement!;
  expect(within(idle).getByText(/cannot host kernels/i)).toBeInTheDocument();

  cleanup();
  render(
    <MachinesList
      {...props}
      kernels={[
        { ...kernel, id: "k_1", machineId: "rt_1", state: "running" },
        { ...kernel, id: "k_2", machineId: "rt_1" },
      ]}
    />,
  );
  const holding = screen.getByRole("button", { name: /^ana-macbook —/ }).parentElement!;
  expect(within(holding).getByText("2 kernels · 1 running")).toBeInTheDocument();
});

it("puts what a screen hands it between the roster and the way to add to it", () => {
  // Ordering is the whole reason this is a slot: adding a machine is the last
  // thing on the page, under everything that says what the machines already
  // on it are. A caller rendering its own blocks after the list could not get
  // beneath that card at all.
  render(
    <MachinesList {...props}>
      <p>Agents on ana-macbook</p>
    </MachinesList>,
  );

  const order = ["ana-macbook", "Agents on ana-macbook", "Add a machine"].map((text) =>
    screen.getByText(text).compareDocumentPosition(screen.getByText("Add a machine")),
  );
  // The roster's own row and the handed-in block both precede the card; the
  // card does not precede itself.
  expect(order[0] & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(order[1] & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    screen
      .getByText("Agents on ana-macbook")
      .compareDocumentPosition(screen.getByText("ana-macbook")) &
      Node.DOCUMENT_POSITION_PRECEDING,
  ).toBeTruthy();
});

it("shows a header figure that is the sum of the rows under it", () => {
  // The reason `computeSnapshot` shares one fan-out. If these ever disagree
  // on screen, the two calls came from different sweeps.
  render(
    <MachinesList
      {...props}
      kernels={[
        { ...kernel, id: "k_1", machineId: "rt_1", resources: { memoryBytes: 4_194_304 } },
        { ...kernel, id: "k_2", machineId: "rt_1", resources: { memoryBytes: 2_097_152 } },
      ]}
      compute={[{ machineId: "rt_1", memoryBytes: 6_291_456, totalMemoryBytes: 8 * 1024 ** 3 }]}
    />,
  );
  expect(screen.getByText("6.0 MB of 8.0 GB")).toBeInTheDocument();
  expect(screen.getByText("4.0 MB")).toBeInTheDocument();
  expect(screen.getByText("2.0 MB")).toBeInTheDocument();
});

/** One declared environment as a machine holds it. `absent` deliberately
 *  carries no `version`, no `packageCount` and no `lockRevision` — those are
 *  measurements of a build that never happened here, and inventing zeros for
 *  them is the thing this screen must not do. */
function envStatus(overrides: Partial<KernelEnvStatus> = {}): KernelEnvStatus {
  return {
    state: "absent",
    name: "crispr",
    language: "python",
    manager: "uv",
    platform: "macos-aarch64",
    root: "",
    ...overrides,
  };
}

/** The lab's own declaration of one environment. `createdBy` is present by
 *  default: an absent one means Lykeion declared it, which is the starter,
 *  and the starter may not be deleted. */
function declaration(
  overrides: Partial<KernelEnvDeclaration> = {},
): KernelEnvDeclaration {
  return {
    name: "crispr",
    language: "python",
    manager: "uv",
    packages: ["scanpy"],
    createdBy: "u_you",
    createdTs: 1_700_000_000,
    lockRevision: 1,
    ...overrides,
  };
}

it("shows a declared environment under a machine that has never built it", () => {
  render(
    <MachinesList
      {...props}
      compute={[{ machineId: "rt_1", environments: [envStatus()] }]}
      declarations={[declaration()]}
    />,
  );
  expect(screen.getByText("crispr")).toBeInTheDocument();
  expect(screen.getByText(/not built here/i)).toBeInTheDocument();
  // Information, not a call to action: setting up happens where the work is
  // blocked, which is the Notebook, never here.
  expect(screen.queryByRole("button", { name: /set up/i })).not.toBeInTheDocument();
});

it("opens a machine that holds environments but is running nothing", () => {
  // The disclosure used to be gated on kernels alone, which left a machine
  // that has built gigabytes and is running nothing with no way to show them
  // — on the one screen that exists to say what a machine holds.
  render(
    <MachinesList
      {...props}
      kernels={[]}
      compute={[{ machineId: "rt_1", environments: [envStatus({ state: "ready" })] }]}
      declarations={[declaration()]}
    />,
  );
  expect(screen.getByText("crispr")).toBeInTheDocument();
});

it("tells a half-built copy apart from one that was never built", () => {
  // Different states, different fixes: `broken` is an interrupted provision
  // and wants building again; `absent` was never started here. Given the same
  // word, a researcher watching a build die would see it settle into
  // something that looks like it never began.
  render(
    <MachinesList
      {...props}
      compute={[
        {
          machineId: "rt_1",
          environments: [
            envStatus({ name: "crispr", state: "broken" }),
            envStatus({ name: "atacseq", state: "absent" }),
          ],
        },
      ]}
      declarations={[declaration(), declaration({ name: "atacseq" })]}
    />,
  );
  expect(screen.getByText(/half-built/i)).toBeInTheDocument();
  expect(screen.getByText(/not built here/i)).toBeInTheDocument();
});

it("renders no figure for a build that never happened here", () => {
  // Absent is not zero. An `absent` row measured nothing, so it says nothing
  // — never `0 packages`, which is a real state a real build can be in.
  render(
    <MachinesList
      {...props}
      compute={[{ machineId: "rt_1", environments: [envStatus()] }]}
      declarations={[declaration()]}
    />,
  );
  expect(screen.queryByText(/0 packages/)).not.toBeInTheDocument();
  // Scoped to the environment's own row: the machine row above it renders an
  // em dash for every figure IT could not measure, so an unscoped query here
  // would pass on the machine's unreported memory and never look at the
  // environment at all.
  const row = screen.getByText("crispr").closest("li");
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByText("—")).toBeInTheDocument();
});

it("says when a machine's copy is a revision behind the lab's own pin", () => {
  render(
    <MachinesList
      {...props}
      compute={[
        {
          machineId: "rt_1",
          environments: [
            envStatus({ state: "ready", packageCount: 12, version: "3.12.7", lockRevision: 1 }),
          ],
        },
      ]}
      declarations={[declaration({ lockRevision: 3 })]}
    />,
  );
  expect(screen.getByText(/a revision behind/i)).toBeInTheDocument();
  expect(screen.getByText(/12 packages/)).toBeInTheDocument();
});

it("says nothing about revisions for a machine holding the lab's current pin", () => {
  // The other half, and the half that keeps the line above honest: a test
  // that only asserts the warning appears would pass against a row that
  // always warns.
  render(
    <MachinesList
      {...props}
      compute={[
        { machineId: "rt_1", environments: [envStatus({ state: "ready", lockRevision: 3 })] },
      ]}
      declarations={[declaration({ lockRevision: 3 })]}
    />,
  );
  expect(screen.queryByText(/a revision behind/i)).not.toBeInTheDocument();
});

it("keeps freeing a machine's copy apart from deleting the environment", async () => {
  // Two different actions with two different blast radii. The row action is
  // the small, local, reversible one, and choosing it must never reach the
  // lab-wide delete.
  const onReclaim = vi.fn();
  const onDelete = vi.fn();
  render(
    <MachinesList
      {...props}
      compute={[{ machineId: "rt_1", environments: [envStatus({ state: "ready" })] }]}
      declarations={[declaration()]}
      onReclaim={onReclaim}
      onDelete={onDelete}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /free ana-macbook's copy of crispr/i }),
  );
  // Inline, in the row — the pattern the Stop control established — and it
  // names both the environment and the machine, so the answer is not given
  // from memory of which row was clicked.
  expect(screen.getByText(/free crispr from ana-macbook/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Free" }));
  expect(onReclaim).toHaveBeenCalledWith("rt_1", "crispr");
  expect(onDelete).not.toHaveBeenCalled();
});

it("asks before it frees anything, and frees nothing if the answer is no", async () => {
  const onReclaim = vi.fn();
  render(
    <MachinesList
      {...props}
      compute={[{ machineId: "rt_1", environments: [envStatus({ state: "ready" })] }]}
      declarations={[declaration()]}
      onReclaim={onReclaim}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /free ana-macbook's copy of crispr/i }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onReclaim).not.toHaveBeenCalled();
});

it("offers nothing to free on a machine that has built nothing", () => {
  render(
    <MachinesList
      {...props}
      compute={[{ machineId: "rt_1", environments: [envStatus()] }]}
      declarations={[declaration()]}
      onReclaim={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /free ana-macbook's copy/i })).not.toBeInTheDocument();
});

it("offers no delete for Lykeion's own starter environment", async () => {
  // An absent `createdBy` means Lykeion declared it, not a person — and the
  // core refuses to delete it (D7), so a control here could only ever fail.
  const onDelete = vi.fn();
  render(
    <MachinesList
      {...props}
      compute={[
        { machineId: "rt_1", environments: [envStatus({ name: "python", state: "ready" })] },
      ]}
      declarations={[declaration({ name: "python", createdBy: undefined })]}
      onDelete={onDelete}
    />,
  );
  expect(
    screen.queryByRole("button", { name: /delete the environment python/i }),
  ).not.toBeInTheDocument();
});

it("deletes an environment for the whole lab only after saying so", async () => {
  const onDelete = vi.fn();
  const onReclaim = vi.fn();
  render(
    <MachinesList
      {...props}
      compute={[{ machineId: "rt_1", environments: [envStatus({ state: "ready" })] }]}
      declarations={[declaration()]}
      onDelete={onDelete}
      onReclaim={onReclaim}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /delete the environment crispr for the whole lab/i }),
  );
  expect(screen.getByText(/delete crispr for the whole lab/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onDelete).toHaveBeenCalledWith("crispr");
  expect(onReclaim).not.toHaveBeenCalled();
});
