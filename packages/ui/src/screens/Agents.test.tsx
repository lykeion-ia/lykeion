import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type Connector,
  type LykeionApi,
  type Machine,
} from "@lykeion/api";
import App from "../App";

function machine(id: string, name: string, ownerId: string): Machine {
  return {
    id,
    name,
    ownerId,
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    health: "online",
    lastSeenTs: 1_700_000_000,
    capabilities: [],
  };
}

function connector(name: string, enabled: boolean): Connector {
  return {
    name,
    description: "",
    server: { args: [], env: {} },
    enabled,
    skipApprovals: false,
  };
}

afterEach(cleanup);

it("lists experts, opens a detail with instructions + tools, and opens the create modal", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /^Experts$/i }));

  // Seeded expert row.
  expect(await screen.findByText("statistician")).toBeInTheDocument();

  // Open its detail → Instructions tab shows the real systemPrompt; Tools tab lists tools.
  await user.click(screen.getByText("statistician"));
  expect(
    await screen.findByText(/meticulous statistician/i),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Tools" }));
  expect(screen.getByText("Bash")).toBeInTheDocument();
});

it("opens the Create Expert modal from the Experts list", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /^Experts$/i }));
  await user.click(await screen.findByRole("button", { name: /New expert/i }));
  expect(
    await screen.findByRole("dialog", { name: /Create expert/i }),
  ).toBeInTheDocument();
});

it("offers the caller's own machines in the machine picker and never defaults to a colleague's", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const me = await api.currentUser();
  const spied: LykeionApi = {
    ...api,
    // The lab's roster comes back sorted by name, so the alphabetically
    // first machine in it belongs to somebody else — which is exactly what a
    // picker defaulting to the head of the list would assert as the
    // caller's.
    listMachines: async () => [
      machine("rt_a", "alpha-workstation", "u_somebody_else"),
      machine("rt_z", "zoe-macbook", me.id),
    ],
  };
  render(<App api={spied} />);
  await user.click(await screen.findByRole("link", { name: /^Experts$/i }));
  await user.click(await screen.findByRole("button", { name: /New expert/i }));

  const dialog = await screen.findByRole("dialog", { name: /Create expert/i });
  // The default reads off the caller's own machines, not the lab's.
  const picker = await within(dialog).findByRole("button", {
    name: /zoe-macbook/i,
  });
  expect(within(dialog).queryByText("alpha-workstation")).toBeNull();

  // And a colleague's machine is not one row further down the menu either.
  // Two matches once it is open — the trigger and the one row — which is
  // also what proves the menu opened rather than the assertion below
  // passing against a menu that never rendered.
  await user.click(picker);
  expect(
    within(dialog).getAllByRole("button", { name: /zoe-macbook/i }),
  ).toHaveLength(2);
  expect(within(dialog).queryByText("alpha-workstation")).toBeNull();
});

it("passes only the Lab's ENABLED connectors into the Create Expert modal, and a selected connector really persists onto the created Expert", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const spied: LykeionApi = {
    ...api,
    listConnectors: async () => [
      connector("pubmed", true),
      connector("disabled-one", false),
    ],
  };
  render(<App api={spied} />);
  await user.click(await screen.findByRole("link", { name: /^Experts$/i }));
  await user.click(await screen.findByRole("button", { name: /New expert/i }));

  await user.type(
    screen.getByPlaceholderText(/Deep Research Expert/i),
    "Curator",
  );
  await user.click(screen.getByRole("button", { name: /Add connectors/i }));
  expect(screen.getByRole("button", { name: "pubmed" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "disabled-one" }),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "pubmed" }));
  await user.click(screen.getByRole("button", { name: "Create" }));

  // Real persistence (not the decorative skills drop): re-open the new expert
  // and its Connectors tab shows the assignment came back from the store.
  await user.click(await screen.findByText("Curator"));
  await user.click(screen.getByRole("button", { name: "Connectors" }));
  expect(await screen.findByText("pubmed")).toBeInTheDocument();
});
