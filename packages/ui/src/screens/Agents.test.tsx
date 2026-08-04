import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type Connector,
  type LykeionApi,
  type Runtime,
} from "@lykeion/api";
import App from "../App";

function runtime(id: string, name: string, ownerId: string): Runtime {
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

it("lists agents, opens a detail with instructions + tools, and opens the create modal", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /^Agents$/i }));

  // Seeded agent row.
  expect(await screen.findByText("statistician")).toBeInTheDocument();

  // Open its detail → Instructions tab shows the real systemPrompt; Tools tab lists tools.
  await user.click(screen.getByText("statistician"));
  expect(
    await screen.findByText(/meticulous statistician/i),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Tools" }));
  expect(screen.getByText("Bash")).toBeInTheDocument();
});

it("opens the Create Agent modal from the Agents list", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /^Agents$/i }));
  await user.click(await screen.findByRole("button", { name: /New agent/i }));
  expect(
    await screen.findByRole("dialog", { name: /Create agent/i }),
  ).toBeInTheDocument();
});

it("offers the caller's own machines in the runtime picker and never defaults to a colleague's", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const me = await api.currentUser();
  const spied: LykeionApi = {
    ...api,
    // The lab's roster comes back sorted by name, so the alphabetically
    // first machine in it belongs to somebody else — which is exactly what a
    // picker defaulting to the head of the list would assert as the
    // caller's.
    listRuntimes: async () => [
      runtime("rt_a", "alpha-workstation", "u_somebody_else"),
      runtime("rt_z", "zoe-macbook", me.id),
    ],
  };
  render(<App api={spied} />);
  await user.click(await screen.findByRole("link", { name: /^Agents$/i }));
  await user.click(await screen.findByRole("button", { name: /New agent/i }));

  const dialog = await screen.findByRole("dialog", { name: /Create agent/i });
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

it("passes only the Lab's ENABLED connectors into the Create Agent modal, and a selected connector really persists onto the created Agent", async () => {
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
  await user.click(await screen.findByRole("link", { name: /^Agents$/i }));
  await user.click(await screen.findByRole("button", { name: /New agent/i }));

  await user.type(
    screen.getByPlaceholderText(/Deep Research Agent/i),
    "Curator",
  );
  await user.click(screen.getByRole("button", { name: /Add connectors/i }));
  expect(screen.getByRole("button", { name: "pubmed" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "disabled-one" }),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "pubmed" }));
  await user.click(screen.getByRole("button", { name: "Create" }));

  // Real persistence (not the decorative skills drop): re-open the new agent
  // and its Connectors tab shows the assignment came back from the store.
  await user.click(await screen.findByText("Curator"));
  await user.click(screen.getByRole("button", { name: "Connectors" }));
  expect(await screen.findByText("pubmed")).toBeInTheDocument();
});
