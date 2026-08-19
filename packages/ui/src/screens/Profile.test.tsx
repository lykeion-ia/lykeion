import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

// Usage is the Settings › Workspace › Profile tab; it left the Rail with Skills
// and Connectors, so it is reached through Settings rather than a nav link.
it("renders the usage dashboard with zeroed stats and both panels on a fresh core", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Profile" }));

  // Page title + both panel headings render even with no data.
  expect(await screen.findByText("Daily tokens")).toBeInTheDocument();
  expect(screen.getByText("Leaderboard")).toBeInTheDocument();
  // Empty leaderboard reports zero experts.
  expect(screen.getByText("0 experts")).toBeInTheDocument();
  // Zero figures come from real (empty) data, not invented content. The Cost
  // card sub-line is unambiguous; the "0.00M" token figure appears in several
  // places, so match it with getAllByText rather than getByText.
  expect(screen.getByText("Across 0 researches")).toBeInTheDocument();
  expect(screen.getAllByText("0.00M").length).toBeGreaterThan(0);
});

// The old `#/usage` hash lands on the surface it always did, now inside
// Settings — a bookmark to the dashboard survives the move.
it("opens the Profile tab from the retired #/usage hash", async () => {
  window.location.hash = "#/usage";
  render(<App api={createInMemoryApi(emptySeed())} />);

  expect(await screen.findByText("Daily tokens")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
});
