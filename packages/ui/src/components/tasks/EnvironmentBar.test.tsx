import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EnvironmentSetupJob,
  EnvironmentSetupStage,
  KernelEnvDeclaration,
  KernelEnvStatus,
  TaskEnvironmentSetup,
} from "@lykeion/api";
import { EnvironmentBar, type EnvironmentBarProps } from "./EnvironmentBar";

afterEach(cleanup);

const pythonDeclaration = (): KernelEnvDeclaration => ({
  name: "python",
  language: "python",
  manager: "uv",
  packages: ["numpy", "pandas"],
  createdTs: 0,
  lockRevision: 1,
});

const rDeclaration = (): KernelEnvDeclaration => ({
  name: "r",
  language: "r",
  manager: "conda",
  packages: ["tidyverse"],
  createdTs: 0,
  lockRevision: 1,
});

/** The environment the setup fixtures below build: declared by a person, so
 *  it is neither language's starter and every selection rule has to name it
 *  for a reason rather than fall onto it. */
const metaDeclaration = (): KernelEnvDeclaration => ({
  name: "meta-analysis-r",
  language: "r",
  manager: "conda",
  packages: ["metafor"],
  createdBy: "u_ana",
  createdTs: 0,
  lockRevision: 3,
});

const T0 = 1_700_000_000_000;

const jobFixture = (over: Partial<EnvironmentSetupJob> = {}): EnvironmentSetupJob => ({
  id: "job_1",
  machineId: "m_1",
  machineName: "Mac",
  environmentName: "meta-analysis-r",
  language: "r",
  manager: "conda",
  lockRevision: 3,
  state: "requested",
  stage: "waiting-for-machine",
  requestedTs: T0,
  updatedTs: T0,
  log: [],
  ...over,
});

const requested = (): TaskEnvironmentSetup => ({ job: jobFixture() });

/** A build the machine has picked up, `elapsed` seconds into it. The elapsed
 *  figure is the server's own two timestamps, never a clock running here —
 *  a bar that ticked on its own would be inventing progress between reports. */
const building = (
  stage: EnvironmentSetupStage,
  elapsed: number,
): TaskEnvironmentSetup => ({
  job: jobFixture({
    state: "building",
    stage,
    startedTs: T0,
    updatedTs: T0 + elapsed * 1000,
  }),
});

const readyAndContinuing = (): TaskEnvironmentSetup => ({
  job: jobFixture({
    state: "ready",
    stage: "finalizing",
    startedTs: T0,
    finishedTs: T0 + 30_000,
    updatedTs: T0 + 30_000,
  }),
  waiter: {
    id: "w_1",
    sourceRunId: "run_1",
    sourceTurnId: "turn_1",
    state: "queued",
  },
});

/** What the machine reports about `meta-analysis-r`: declared here, and not
 *  built on this machine. A machine that has NOT reported is this prop being
 *  absent — a different fact, and the bar is required to tell them apart. */
const absentStatus = (): KernelEnvStatus => ({
  state: "absent",
  name: "meta-analysis-r",
  language: "r",
  manager: "conda",
  platform: "macos-aarch64",
  root: "/x/envs/meta-analysis-r",
});

/** The same environment as the machine reports it once it holds a working
 *  copy — and as one whose build began and was interrupted. */
const readyStatus = (): KernelEnvStatus => ({ ...absentStatus(), state: "ready" });
const brokenStatus = (): KernelEnvStatus => ({ ...absentStatus(), state: "broken" });

const failedSetup = (summary: string): TaskEnvironmentSetup => ({
  job: jobFixture({
    state: "failed",
    stage: "resolving",
    startedTs: T0,
    finishedTs: T0 + 5_000,
    updatedTs: T0 + 5_000,
    errorSummary: summary,
    log: ["resolving metafor…", "error: no solution found"],
  }),
  waiter: {
    id: "w_1",
    sourceRunId: "run_1",
    sourceTurnId: "turn_1",
    state: "waiting",
  },
});

const readyWithSuggestion = (): TaskEnvironmentSetup => ({
  ...readyAndContinuing(),
  suggestion: {
    id: "sug_1",
    language: "r",
    environmentName: "meta-analysis-r",
    state: "pending",
  },
});

const BASE: EnvironmentBarProps = {
  taskId: "tk_1",
  language: "r",
  environments: [metaDeclaration()],
  selectedEnvironment: "meta-analysis-r",
  machineOptions: [{ machineId: "m_1", label: "Mac" }],
  selectedMachineId: "m_1",
  onSelectEnvironment: () => {},
  onSelectMachine: () => {},
  onSetup: async () => {},
  onRetry: async () => {},
  onAnswerSuggestion: async () => {},
};

function props(over: Partial<EnvironmentBarProps> = {}): EnvironmentBarProps {
  return { ...BASE, ...over };
}

function renderBar(over: Partial<EnvironmentBarProps> = {}) {
  return render(<EnvironmentBar {...props(over)} />);
}

it("shows every declared environment in one named listbox even under the Python lens", async () => {
  const user = userEvent.setup();
  renderBar({ language: "python", environments: [pythonDeclaration(), rDeclaration()] });
  await user.click(screen.getByRole("button", { name: /environment/i }));
  expect(screen.getByRole("listbox", { name: "Kernel environment" })).toBeVisible();
  expect(screen.getByRole("option", { name: "python" })).toBeVisible();
  expect(screen.getByRole("option", { name: "r" })).toBeVisible();
});

it("announces phase changes but not elapsed-time ticks", () => {
  const { rerender } = renderBar({ setup: building("resolving", 12) });
  expect(screen.getByRole("status")).toHaveTextContent("Resolving packages");
  rerender(<EnvironmentBar {...props({ setup: building("resolving", 13) })} />);
  expect(screen.getByRole("status")).toHaveTextContent("Resolving packages");
  rerender(<EnvironmentBar {...props({ setup: building("installing", 14) })} />);
  expect(screen.getByRole("status")).toHaveTextContent("Installing packages");
});

it("keeps focus on the setup button when readiness starts the continuation", () => {
  const { rerender } = renderBar({ setup: requested() });
  const button = screen.getByRole("button", { name: "Set up meta-analysis-r on Mac" });
  button.focus();
  rerender(<EnvironmentBar {...props({ setup: readyAndContinuing() })} />);
  expect(document.activeElement).toBe(button);
});

it("names the popup it owns, and says when it is open", async () => {
  const user = userEvent.setup();
  renderBar({ environments: [pythonDeclaration(), rDeclaration()] });
  const trigger = screen.getByRole("button", { name: /environment/i });
  expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  expect(trigger).toHaveAttribute("aria-expanded", "false");

  await user.click(trigger);

  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const list = screen.getByRole("listbox", { name: "Kernel environment" });
  expect(trigger).toHaveAttribute("aria-controls", list.id);
});

it("opens on Arrow Down, walks the list, and selects with Enter", async () => {
  const user = userEvent.setup();
  const onSelectEnvironment = vi.fn();
  renderBar({
    environments: [pythonDeclaration(), rDeclaration()],
    language: "python",
    selectedEnvironment: "python",
    onSelectEnvironment,
  });
  const trigger = screen.getByRole("button", { name: /environment/i });
  trigger.focus();

  await user.keyboard("{ArrowDown}");
  const list = screen.getByRole("listbox", { name: "Kernel environment" });
  // The list takes the focus, and says which option a keyboard is standing on
  // without moving the browser's own focus off the widget.
  expect(document.activeElement).toBe(list);
  expect(list).toHaveAttribute(
    "aria-activedescendant",
    within(list).getByRole("option", { name: "python" }).id,
  );

  await user.keyboard("{ArrowDown}");
  expect(list).toHaveAttribute(
    "aria-activedescendant",
    within(list).getByRole("option", { name: "r" }).id,
  );

  await user.keyboard("{ArrowUp}{ArrowDown}{Enter}");

  expect(onSelectEnvironment).toHaveBeenCalledExactlyOnceWith("r");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(trigger);
});

it("closes on Escape and hands focus back to the trigger", async () => {
  const user = userEvent.setup();
  const onSelectEnvironment = vi.fn();
  renderBar({
    environments: [pythonDeclaration(), rDeclaration()],
    onSelectEnvironment,
  });
  const trigger = screen.getByRole("button", { name: /environment/i });
  await user.click(trigger);

  await user.keyboard("{Escape}");

  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  // Not the document body. A popup that vanishes and drops focus loses a
  // keyboard reader their place on the whole screen, not just in this list.
  expect(document.activeElement).toBe(trigger);
  expect(onSelectEnvironment).not.toHaveBeenCalled();
});

it("shows an indeterminate track while a build runs, and never a percentage", () => {
  renderBar({ setup: building("resolving", 12) });
  const track = screen.getByRole("progressbar");
  // Nothing upstream measures a fraction of a package solve, so nothing here
  // publishes one — a drawn percentage would be the only number on this
  // surface a researcher would plan around, and it would be invented.
  expect(track).not.toHaveAttribute("aria-valuenow");
  expect(track).not.toHaveAttribute("aria-valuetext");
  // The element the reduced-motion rule keys on, by the name the plan gives it.
  expect(track.querySelector(".envbar-progress__indicator")).not.toBeNull();
});

it("keeps the elapsed figure out of the announcement and out of the tree", () => {
  renderBar({ setup: building("installing", 75) });
  expect(screen.getByRole("status")).not.toHaveTextContent("1m 15s");
  expect(screen.getByText("1m 15s")).toHaveAttribute("aria-hidden", "true");
});

it("says each state in words beside an icon, never in colour alone", () => {
  const cases: Array<[Partial<EnvironmentBarProps>, string]> = [
    [{ status: absentStatus() }, "Setup needed"],
    [{ setup: requested() }, "Waiting for Mac to report"],
    [{ setup: building("installing", 3) }, "Installing packages"],
    [{ setup: readyAndContinuing() }, "Ready"],
    [{ setup: failedSetup("no solution found") }, "Setup failed"],
  ];
  for (const [over, words] of cases) {
    const { unmount } = renderBar(over);
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent(words);
    // The shape beside the sentence. Both carry the state, so a reader who
    // cannot tell green from red loses nothing.
    expect(line.querySelector("svg")).not.toBeNull();
    unmount();
  }
});

it("opens the disclosure on a failure and leaves it shut on an ordinary build", () => {
  const { unmount } = renderBar({ setup: building("installing", 4) });
  expect(screen.getByText("Full details").closest("details")).not.toHaveAttribute("open");
  unmount();

  renderBar({ setup: failedSetup("no solution found") });
  expect(screen.getByText("Full details").closest("details")).toHaveAttribute("open");
});

it("raises one alert with a bounded excerpt, and offers Retry and the whole of it", async () => {
  const user = userEvent.setup();
  const onRetry = vi.fn(async () => {});
  const summary = `metafor: ${"x".repeat(600)}`;
  renderBar({ setup: failedSetup(summary), onRetry });

  const alerts = screen.getAllByRole("alert");
  expect(alerts).toHaveLength(1);
  // Bounded at a glance — the server bounds what it keeps, this bounds what
  // is read on one line — and ended with an ellipsis rather than mid-word.
  expect(alerts[0].textContent).toHaveLength(241);
  expect(alerts[0]).toHaveTextContent(/^metafor: x+…$/);
  // And the whole of it one disclosure away, wrapped rather than clipped.
  expect(screen.getByText("Full details").closest("details")).toHaveTextContent(summary);

  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledExactlyOnceWith("w_1");
});

it("sends one setup request, and refuses a second press while a job is in flight", async () => {
  const user = userEvent.setup();
  const onSetup = vi.fn(async () => {});
  const { rerender } = renderBar({ status: absentStatus(), onSetup });

  const button = screen.getByRole("button", { name: "Set up meta-analysis-r on Mac" });
  expect(button).toHaveAttribute("aria-disabled", "false");
  await user.click(button);
  expect(onSetup).toHaveBeenCalledTimes(1);

  // The server now says a job is running. The button stays exactly where it
  // was — refusing, not gone — so the finger that pressed it keeps its place.
  rerender(
    <EnvironmentBar
      {...props({ status: absentStatus(), setup: building("resolving", 2), onSetup })}
    />,
  );
  expect(screen.getByRole("button", { name: "Set up meta-analysis-r on Mac" })).toBe(button);
  expect(button).toHaveAttribute("aria-disabled", "true");
  await user.click(button);
  expect(onSetup).toHaveBeenCalledTimes(1);
});

it("shows the request's own refusal without touching what the job says", async () => {
  const user = userEvent.setup();
  const onSetup = vi.fn(async () => {
    throw new Error("that machine is offline");
  });
  renderBar({ status: absentStatus(), onSetup });

  await user.click(screen.getByRole("button", { name: "Set up meta-analysis-r on Mac" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("that machine is offline");
  // The bar did not decide anything on the strength of a refused command.
  expect(screen.getByRole("status")).toHaveTextContent("Setup needed");
});

it("asks the default question once the job is ready, and keeps it up when the answer is refused", async () => {
  const user = userEvent.setup();
  const onAnswerSuggestion = vi.fn(async () => {
    throw new Error("that suggestion is no longer open");
  });
  renderBar({ setup: readyWithSuggestion(), onAnswerSuggestion });

  expect(
    screen.getByText(/Use meta-analysis-r for future R work in this Research\?/),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Agent continuing…");

  await user.click(screen.getByRole("button", { name: "Use by default" }));

  expect(onAnswerSuggestion).toHaveBeenCalledExactlyOnceWith("sug_1", true);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "that suggestion is no longer open",
  );
  // The question is the server's to withdraw. A refused answer leaves it
  // standing, and leaves the agent's continuation exactly as it was.
  expect(
    screen.getByText(/Use meta-analysis-r for future R work in this Research\?/),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Agent continuing…");
});

it("declines a default without holding up the continuation", async () => {
  const user = userEvent.setup();
  const onAnswerSuggestion = vi.fn(async () => {});
  renderBar({ setup: readyWithSuggestion(), onAnswerSuggestion });

  await user.click(screen.getByRole("button", { name: "Not now" }));

  expect(onAnswerSuggestion).toHaveBeenCalledExactlyOnceWith("sug_1", false);
  expect(screen.getByRole("status")).toHaveTextContent("Agent continuing…");
});

it("marks this Research's default in the list without renaming the option", async () => {
  const user = userEvent.setup();
  renderBar({
    environments: [pythonDeclaration(), rDeclaration()],
    selectedEnvironment: "r",
    defaultEnvironment: "r",
  });
  await user.click(screen.getByRole("button", { name: /environment/i }));

  const option = screen.getByRole("option", { name: "r" });
  // The note is decoration on an option that is still addressable by the one
  // thing it is called.
  expect(option).toHaveTextContent("default");
  expect(option).toHaveAttribute("aria-selected", "true");
});

it("drops a refused command's error once the server has newer news", async () => {
  const user = userEvent.setup();
  const onSetup = vi.fn(async () => {
    throw new Error("that machine is offline");
  });
  const { rerender } = renderBar({ status: absentStatus(), onSetup });

  await user.click(screen.getByRole("button", { name: "Set up meta-analysis-r on Mac" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("that machine is offline");

  // A job appeared — from another tab, or from the agent. The refusal of a
  // command sent before it is no longer a fact about anything.
  rerender(
    <EnvironmentBar
      {...props({ status: absentStatus(), setup: building("resolving", 2), onSetup })}
    />,
  );

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Resolving packages");
});

it("offers nothing to press on a healthy environment this Task never set up", () => {
  // An offer to rebuild what is already there asks a researcher to spend a
  // gigabyte on nothing, and on a line where everything is well it would be
  // the loudest thing on the bar. The fact is worth stating; the control is
  // not worth drawing.
  renderBar({ status: readyStatus() });
  expect(screen.getByRole("status")).toHaveTextContent("Ready");
  expect(screen.queryByRole("button", { name: /^(Set up|Rebuild)/ })).not.toBeInTheDocument();
});

it("keeps the same button through a readiness that lands in the machine's report too", () => {
  // The gate above is on the JOB, not on the status, and this is why that is
  // safe: a build this Task asked for keeps its control mounted through every
  // state of the job — including the tick where the machine's own report
  // catches up and says `ready` as well. Same node, same focus, new word.
  const { rerender } = renderBar({
    status: absentStatus(),
    setup: building("installing", 5),
  });
  const button = screen.getByRole("button", { name: "Set up meta-analysis-r on Mac" });
  button.focus();

  rerender(
    <EnvironmentBar {...props({ status: readyStatus(), setup: readyAndContinuing() })} />,
  );

  expect(document.activeElement).toBe(button);
  expect(button).toHaveAccessibleName("Rebuild meta-analysis-r on Mac");
});

it("calls a broken copy failed only when a job explicitly failed", () => {
  // Both halves of the same row. `broken` is a provision that began and was
  // interrupted; that is work outstanding, not an error, until a job says
  // otherwise — and telling a researcher their build failed when nothing
  // reported a failure is a claim about their machine nobody made.
  const { unmount } = renderBar({ status: brokenStatus() });
  expect(screen.getByRole("status")).toHaveTextContent("Setup needed");
  expect(screen.getByRole("status")).not.toHaveTextContent("Setup failed");
  expect(
    screen.getByRole("button", { name: "Rebuild meta-analysis-r on Mac" }),
  ).toBeInTheDocument();
  unmount();

  renderBar({ status: brokenStatus(), setup: failedSetup("no solution found") });
  expect(screen.getByRole("status")).toHaveTextContent("Setup failed");
  expect(screen.getByRole("alert")).toHaveTextContent("no solution found");
});
