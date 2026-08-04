import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type LykeionApi, type Runtime } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { RuntimesList } from "./RuntimesList";

afterEach(cleanup);

function machine(overrides: Partial<Runtime> = {}): Runtime {
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

function renderList(
  runtimes: Runtime[],
  meId: string | null,
  apiOverrides: Partial<LykeionApi> = {},
) {
  const api: LykeionApi = { ...createInMemoryApi(), ...apiOverrides };
  return render(
    <ApiProvider api={api}>
      <RuntimesList runtimes={runtimes} meId={meId} />
    </ApiProvider>,
  );
}

it("names the machine, its platform and its health", () => {
  renderList([machine()], "u_you");
  expect(screen.getByText("ana-macbook")).toBeInTheDocument();
  expect(screen.getByText("macos-aarch64")).toBeInTheDocument();
  expect(screen.getByText(/online/i)).toBeInTheDocument();
});

function cli(over: Partial<import("@lykeion/api").AgentCli> = {}) {
  return {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    version: "1.2.3",
    available: true,
    runtimeId: "rt_1",
    ...over,
  };
}

it("lists the commands found on your own machine", () => {
  renderList([machine({ clis: [cli()] })], "u_you");
  expect(screen.getByText(/claude/i)).toBeInTheDocument();
  expect(screen.getByText("1.2.3")).toBeInTheDocument();
});

it("counts the catalogue's misses instead of naming them one by one", () => {
  // The daemon reports the whole catalogue so the lab knows what was looked
  // for, but a machine with four tools on it would otherwise spend nine
  // rows saying what is not there — and a capability list reads as things
  // the machine can do, not things it cannot.
  renderList(
    [
      machine({
        clis: [
          cli(),
          cli({ id: "codex", name: "Codex", command: "codex", version: "0.5.0" }),
          cli({ id: "cursor", name: "Cursor", command: "cursor", version: "", available: false }),
          cli({ id: "kimi", name: "Kimi", command: "kimi", version: "", available: false }),
          cli({ id: "pi", name: "Pi", command: "pi", version: "", available: false }),
        ],
      }),
    ],
    "u_you",
  );
  expect(screen.getByText(/claude/i)).toBeInTheDocument();
  expect(screen.getByText(/codex/i)).toBeInTheDocument();
  expect(screen.getByText("3 others not installed")).toBeInTheDocument();
  expect(screen.queryByText(/cursor/i)).toBeNull();
  expect(screen.queryByText(/kimi/i)).toBeNull();
});

it("says nothing about misses on a machine where everything was found", () => {
  renderList([machine({ clis: [cli()] })], "u_you");
  expect(screen.queryByText(/not installed/i)).toBeNull();
});

it("says a machine has nothing installed rather than counting silently to itself", () => {
  // Every catalogued command missing is the ordinary state of a machine
  // that has none of these tools, and a bare count with no names above it
  // reads as a rendering fault rather than as the answer.
  renderList(
    [
      machine({
        clis: [
          cli({ version: "", available: false }),
          cli({ id: "codex", name: "Codex", command: "codex", version: "", available: false }),
        ],
      }),
    ],
    "u_you",
  );
  expect(screen.getByText(/no agent CLIs found/i)).toBeInTheDocument();
  expect(screen.queryByText(/claude/i)).toBeNull();
});

it("separates your machines from the rest of the lab", () => {
  renderList(
    [machine(), machine({ id: "rt_2", name: "bo-workstation", ownerId: "u_bo" })],
    "u_you",
  );
  const yours = screen.getByRole("list", { name: "Your machines" });
  expect(within(yours).getByText("ana-macbook")).toBeInTheDocument();
  expect(within(yours).queryByText("bo-workstation")).toBeNull();
  const elsewhere = screen.getByRole("list", { name: "Elsewhere in the lab" });
  expect(within(elsewhere).getByText("bo-workstation")).toBeInTheDocument();
});

it("says nothing about what is installed on somebody else's machine", () => {
  // `clis` is absent rather than empty on a machine that is not yours, and
  // the row has to read as "not shown" rather than "nothing installed".
  renderList([machine({ id: "rt_2", ownerId: "u_bo" })], "u_you");
  expect(screen.queryByText(/not installed/i)).toBeNull();
});

it("gives each group a heading a sighted researcher can read, and names the list by it rather than by a second copy", () => {
  renderList(
    [machine(), machine({ id: "rt_2", name: "bo-workstation", ownerId: "u_bo" })],
    "u_you",
  );

  // Visible, and a heading — not an aria-label the screen never shows. Two
  // tables carrying the same column headers are otherwise identical on
  // screen, and which one is yours is the whole point of the split.
  const mine = screen.getByRole("heading", { name: "Your machines" });
  const theirs = screen.getByRole("heading", { name: "Elsewhere in the lab" });
  expect(mine).toBeVisible();
  expect(theirs).toBeVisible();

  // The heading IS the list's accessible name. Were it a separate
  // `aria-label`, the words would exist twice and be announced twice; this
  // asserts the list is named by that very element.
  const yours = screen.getByRole("list", { name: "Your machines" });
  expect(yours.getAttribute("aria-labelledby")).toBe(mine.id);
  expect(yours.getAttribute("aria-label")).toBeNull();
  expect(mine.id).not.toBe("");
  expect(
    screen.getByRole("list", { name: "Elsewhere in the lab" }).getAttribute(
      "aria-labelledby",
    ),
  ).toBe(theirs.id);
});

it("says a colleague's tools are withheld rather than leaving the column blank", () => {
  // Absent, not empty — the lab never sends somebody else's CLI list at all,
  // and a blank cell reads as "this machine has nothing installed".
  const theirs = machine({ id: "rt_2", name: "bo-workstation", ownerId: "u_bo" });
  expect("clis" in theirs).toBe(false);
  renderList([theirs], "u_you");

  expect(
    screen.getByText(/only the member who paired this machine sees its tools/i),
  ).toBeInTheDocument();
});

it("says the version is unknown for an installed command that would not name its build", () => {
  // Available and versionless is neither "Name <version>" nor "Name — not
  // installed"; rendered as a bare word it reads as a rendering fault.
  renderList(
    [
      machine({
        clis: [
          { id: "openclaw", name: "OpenClaw", command: "openclaw", version: "", available: true, runtimeId: "rt_1" },
        ],
      }),
    ],
    "u_you",
  );

  expect(screen.getByText(/version unknown/i)).toBeInTheDocument();
  expect(screen.queryByText(/not installed/i)).toBeNull();
});

it("promises only what a paired machine actually does, and points at the instructions for starting one", () => {
  renderList([], "u_you");

  const card = screen.getByText("Add a computer").parentElement;
  expect(card).not.toBeNull();
  // Nothing can pick up a task on this build, and the composer says so on
  // the screens that host it.
  expect(card).not.toHaveTextContent(/queued task/i);
  expect(card).toHaveTextContent(/running a turn on one is not possible yet/i);
  // A file name is not somewhere a browser can go, so the card has to carry
  // the command itself — filled in with this lab's own address, which is the
  // one part a researcher could not supply from where they are standing.
  expect(card).toHaveTextContent(`pnpm daemon --lab ${window.location.origin}`);
  expect(card).toHaveTextContent("docs/running-the-daemon.md");
});

it("offers Remove on your own machine and on none of the lab's others", () => {
  renderList(
    [machine(), machine({ id: "rt_2", name: "bo-workstation", ownerId: "u_bo" })],
    "u_you",
  );
  const yours = screen.getByRole("list", { name: "Your machines" });
  expect(
    within(yours).getByRole("button", { name: /Remove ana-macbook/i }),
  ).toBeInTheDocument();
  const elsewhere = screen.getByRole("list", { name: "Elsewhere in the lab" });
  expect(
    within(elsewhere).queryByRole("button", { name: /Remove bo-workstation/i }),
  ).toBeNull();
});

it("asks for confirmation before calling removeRuntime, and stays quiet on Cancel", async () => {
  const user = userEvent.setup();
  const removeRuntime = vi.fn().mockResolvedValue(undefined);
  renderList([machine()], "u_you", { removeRuntime });

  await user.click(screen.getByRole("button", { name: /Remove ana-macbook/i }));
  const dialog = await screen.findByRole("dialog", { name: /remove machine/i });
  expect(removeRuntime).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(removeRuntime).not.toHaveBeenCalled();
});

it("calls removeRuntime with the machine's id once the confirmation is confirmed", async () => {
  const user = userEvent.setup();
  const removeRuntime = vi.fn().mockResolvedValue(undefined);
  renderList([machine()], "u_you", { removeRuntime });

  await user.click(screen.getByRole("button", { name: /Remove ana-macbook/i }));
  const dialog = await screen.findByRole("dialog", { name: /remove machine/i });
  await user.click(within(dialog).getByRole("button", { name: /^remove$/i }));

  expect(removeRuntime).toHaveBeenCalledWith("rt_1");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the confirmation open and shows the failure when removeRuntime rejects", async () => {
  const user = userEvent.setup();
  const removeRuntime = vi.fn().mockRejectedValue(new Error("machine already gone"));
  renderList([machine()], "u_you", { removeRuntime });

  await user.click(screen.getByRole("button", { name: /Remove ana-macbook/i }));
  const dialog = await screen.findByRole("dialog", { name: /remove machine/i });
  await user.click(within(dialog).getByRole("button", { name: /^remove$/i }));

  expect(await screen.findByText(/machine already gone/i)).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: /remove machine/i })).toBeInTheDocument();
});
