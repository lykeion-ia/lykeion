import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentCli } from "@lykeion/api";
import { AgentsScreen } from "./AgentsScreen";

afterEach(cleanup);

/**
 * One machine's whole catalogue, one row per state the ladder can stop at.
 *
 * Every field is the real `AgentCli`, not a shorthand: this list arrives from
 * a lab that stored what a daemon reported, and a fixture in a shape nothing
 * produces would let the screen depend on a field that never comes.
 */
const clis: AgentCli[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    version: "2.1.231",
    available: true,
    runtimeId: "rt_1",
    sessionReady: true,
    signedIn: true,
    account: "ana@uni.edu",
    adapterProvenance: "protocol",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    version: "0.58.0",
    available: true,
    runtimeId: "rt_1",
    sessionReady: false,
    sessionReadyReason: "sign in to Codex to run it",
    signedIn: false,
    adapterProvenance: "protocol",
  },
  {
    id: "pi",
    name: "Pi",
    command: "pi",
    version: "0.4.0",
    available: true,
    runtimeId: "rt_1",
    sessionReady: false,
    sessionReadyReason: "pi-acp is published by neither Pi's vendor nor the ACP project",
    adapterProvenance: "community",
  },
  {
    id: "qoder",
    name: "Qoder",
    command: "qoder",
    version: "1.0.0",
    available: true,
    runtimeId: "rt_1",
    sessionReady: false,
    sessionReadyReason: "QODER_HOME is not redirecting it",
    heldBackReason:
      "answered as signed in from a home created empty a moment ago, so Lykeion cannot keep its runs separate from yours",
  },
  {
    id: "kiro",
    name: "Kiro",
    command: "kiro",
    version: "",
    available: false,
    runtimeId: "rt_1",
    sessionReady: false,
    sessionReadyReason: "Lykeion cannot run Kiro yet",
  },
];

it("splits on the one question the researcher owns, and no other", () => {
  // Installed or not is the only line a person can move by doing something.
  // Every other distinction — signed in, held back, waiting on a decision —
  // is a state of a row, not a section of the screen: grouping by them would
  // make rows jump between headings as a probe cycle lands.
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} />);
  expect(screen.getByText("Installed")).toBeInTheDocument();
  expect(screen.getByText("Not installed")).toBeInTheDocument();
  // Bare headers: the counting happens once, in the chips.
  expect(screen.queryByText(/ready ·/i)).toBeNull();
});

it("shows every catalogue row, so the lower half is a shopping list", () => {
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} />);
  for (const cli of clis) expect(screen.getByText(cli.name)).toBeInTheDocument();
});

it("gives a control only to the rows a researcher can act on", () => {
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} />);
  expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
  // Held back is a statement of fact — nothing the researcher does changes it.
  expect(within(screen.getByTestId("row-qoder")).queryByRole("button")).toBeNull();
  // Nor does a row that is already running, or one that is not installed:
  // there is nothing to press on either.
  expect(within(screen.getByTestId("row-claude")).queryByRole("button")).toBeNull();
  expect(within(screen.getByTestId("row-kiro")).queryByRole("button")).toBeNull();
});

it("carries the reason in the row rather than behind a tooltip", () => {
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} />);
  expect(screen.getByText(/home created empty a moment ago/i)).toBeInTheDocument();
});

it("replaces the whole list when this platform cannot confine anything", () => {
  // Not a banner above the list. Every row would be held back for the same
  // reason, and a screen that said it eleven times would read as eleven
  // problems rather than as one fact about the machine.
  render(
    <AgentsScreen clis={clis} platformCanConfine={false} onSignIn={vi.fn()} onReview={vi.fn()} />,
  );
  expect(screen.getByText(/only confine a run on macOS today/i)).toBeInTheDocument();
  expect(screen.queryByText("Claude Code")).toBeNull();
});

it("counts once, in the chips, since the headers gave it up", () => {
  // The headers went bare so nothing has to be recomputed or kept in
  // agreement as rows change state mid-probe. That only works if the chips
  // actually carry the count — drop them and the number disappears from the
  // screen entirely, with every other test still passing.
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} />);
  expect(screen.getByRole("button", { name: "All 5" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Installed 4" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Not installed 1" })).toBeInTheDocument();
});

it("shows one side alone when a chip is chosen", async () => {
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Not installed 1" }));
  expect(screen.getByText("Kiro")).toBeInTheDocument();
  expect(screen.queryByText("Claude Code")).toBeNull();
});

it("lets a researcher leave with nothing signed in, as D-5 requires", async () => {
  const onSkip = vi.fn();
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} onSkip={onSkip} />);
  await userEvent.click(screen.getByRole("button", { name: "Skip" }));
  // Skipping reaches the workbench. It is not a dead end, and it is not a
  // refusal — `lykeion open` brings this screen back whenever they want it.
  expect(onSkip).toHaveBeenCalled();
});

it("offers no sign-in at all where nothing could start one", () => {
  // The lab DISPLAYS this list; only the machine's own front door can spawn a
  // CLI login. Mounted in Runtimes there is no `onSignIn`, and a button that
  // called nothing would be the worst of both — it looks like the way out and
  // does not work.
  render(<AgentsScreen clis={clis} onReview={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  // Review survives, because recording a consent is the lab's to pass on.
  expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
});

it("asks about the agent whose row was pressed", async () => {
  const onReview = vi.fn();
  const onSignIn = vi.fn();
  render(<AgentsScreen clis={clis} onSignIn={onSignIn} onReview={onReview} />);

  await userEvent.click(screen.getByRole("button", { name: /review/i }));
  expect(onReview).toHaveBeenCalledWith("pi");
  await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
  expect(onSignIn).toHaveBeenCalledWith("codex");
});

it("says what a not-installed row would take, since that half is a shopping list", () => {
  const speaksAcp: AgentCli = {
    id: "vendory",
    name: "Vendory",
    command: "vendory",
    version: "",
    available: false,
    runtimeId: "rt_1",
    sessionReady: false,
    adapterProvenance: "vendor",
  };
  render(<AgentsScreen clis={[...clis, speaksAcp]} onSignIn={vi.fn()} onReview={vi.fn()} />);

  // Two different situations for somebody deciding what to install: one needs
  // the CLI and nothing else, the other needs the CLI and a bridge Lykeion
  // does not know about yet.
  expect(within(screen.getByTestId("row-vendory")).getByText(/speaks ACP itself/i)).toBeInTheDocument();
  expect(
    within(screen.getByTestId("row-kiro")).getByText(/no ACP adapter is known yet/i),
  ).toBeInTheDocument();
});

it("names the account an agent is signed in as, which is the whole proof it worked", () => {
  render(<AgentsScreen clis={clis} onSignIn={vi.fn()} onReview={vi.fn()} />);
  expect(within(screen.getByTestId("row-claude")).getByText(/ana@uni\.edu/)).toBeInTheDocument();
});
