import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentCli } from "@lykeion/api";
import { ConsentModal } from "./ConsentModal";
import { AgentsScreen } from "./AgentsScreen";

afterEach(cleanup);

const pi: AgentCli = {
  id: "pi",
  name: "Pi",
  command: "pi",
  version: "0.4.0",
  available: true,
  machineId: "rt_1",
  sessionReady: false,
  sessionReadyReason: "pi-acp is published by neither Pi's vendor nor the ACP project",
  adapterProvenance: "community",
  adapterCommand: "pi-acp",
  adapterVersion: "0.0.33",
  adapterPath: "~/.local/bin/pi-acp",
};

it("states the four facts that make the decision and does not editorialise", () => {
  render(<ConsentModal cli={pi} onAllow={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText("pi-acp")).toBeInTheDocument();
  expect(screen.getByText("0.0.33")).toBeInTheDocument();
  expect(screen.getByText(/neither Pi's vendor nor the ACP project/i)).toBeInTheDocument();
  expect(screen.getByText(/~\/\.local\/bin\/pi-acp/)).toBeInTheDocument();
});

it("says what running it costs, in the terms that actually decide it", () => {
  // Not "is this safe" — nobody can answer that from here. What is knowable
  // is where the program runs: inside the boundary holding this agent's
  // credential, with the network open because the agent needs its vendor.
  render(<ConsentModal cli={pi} onAllow={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Run Pi's adapter?" })).toBeInTheDocument();
  expect(screen.getByText(/neither did Pi's vendor/i)).toBeInTheDocument();
  expect(screen.getByText(/inside the boundary your sessions get/i)).toBeInTheDocument();
});

it("says the version is unknown rather than leaving a blank where a fact goes", () => {
  // A missing fact on a security decision is itself worth knowing. An empty
  // row reads as a rendering fault; a blank next to a label reads as zero.
  const { adapterVersion: _dropped, ...noVersion } = pi;
  render(<ConsentModal cli={noVersion} onAllow={vi.fn()} onDismiss={vi.fn()} />);
  expect(screen.getByText(/did not say/i)).toBeInTheDocument();
});

it("offers no Allow where the answer could not be recorded", () => {
  // An acceptance decides what runs beside a credential in a home the daemon
  // owns, so it is written on that machine and nowhere else. A lab on another
  // computer showing an Allow button would be offering a decision it cannot
  // carry out.
  render(<ConsentModal cli={pi} onDismiss={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /allow/i })).toBeNull();
  expect(screen.getByText(/on that machine/i)).toBeInTheDocument();
  // And the way out is still there — this is a thing to read, not a trap.
  expect(screen.getByRole("button", { name: /not now/i })).toBeInTheDocument();
});

it("leaves the row held back when it is declined, not gone", async () => {
  const onDismiss = vi.fn();
  render(<AgentsScreen clis={[pi]} onSignIn={vi.fn()} onAllow={vi.fn()} onDismiss={onDismiss} />);
  await userEvent.click(screen.getByRole("button", { name: /review/i }));
  await userEvent.click(screen.getByRole("button", { name: /not now/i }));
  // Declining is not a deletion and not an error. The row goes back to being
  // held back with its reason, exactly as any other unclimbed rung does, and
  // Review is still there — a researcher who wants to think about it can.
  expect(screen.getByText("Pi")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /review/i })).toBeInTheDocument();
  expect(screen.getByText(/published by an individual/i)).toBeInTheDocument();
  expect(onDismiss).toHaveBeenCalled();
});

it("opens from the row that needs it, carrying that row's own adapter", async () => {
  const other: AgentCli = { ...pi, id: "other", name: "Other", adapterCommand: "other-acp" };
  render(<AgentsScreen clis={[pi, other]} onAllow={vi.fn()} />);

  await userEvent.click(within(screen.getByTestId("row-other")).getByRole("button", { name: /review/i }));

  expect(screen.getByRole("heading", { name: "Run Other's adapter?" })).toBeInTheDocument();
  expect(screen.getByText("other-acp")).toBeInTheDocument();
  expect(screen.queryByText("pi-acp")).toBeNull();
});

it("tells the caller which agent was allowed, and closes on the answer", async () => {
  const onAllow = vi.fn();
  render(<AgentsScreen clis={[pi]} onAllow={onAllow} />);

  await userEvent.click(screen.getByRole("button", { name: /review/i }));
  await userEvent.click(screen.getByRole("button", { name: /allow on this machine/i }));

  expect(onAllow).toHaveBeenCalledWith("pi");
  expect(screen.queryByRole("dialog")).toBeNull();
});
