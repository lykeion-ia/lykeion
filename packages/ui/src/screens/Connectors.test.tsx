import { afterEach, expect, it } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type Connector,
  type LykeionApi,
} from "@lykeion/api";
import App from "../App";

// Connectors live under Settings › Capabilities (they left the Rail); the
// panel itself renders exactly as it did as a standalone screen.

afterEach(cleanup);

/** Rail › Settings, then the Connectors tab in the settings nav. */
async function openConnectors(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Connectors" }));
}

it("opens the inert 'Add connector' dropdown", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openConnectors(user);

  await user.click(
    await screen.findByRole("button", { name: /Add connector/i }),
  );
  expect(
    await screen.findByRole("menuitem", { name: /Remote URL/i }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: /Local command/i }),
  ).toBeInTheDocument();
});

it("adds a local connector: splits the command and parses env lines", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const calls: Connector[] = [];
  const spied: LykeionApi = {
    ...api,
    addConnector: (connector) => {
      calls.push(connector);
      return api.addConnector(connector);
    },
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(screen.getByRole("button", { name: /Add connector/i }));
  await user.click(screen.getByRole("menuitem", { name: /Local command/i }));

  const dialog = await screen.findByRole("dialog", {
    name: /add local connector/i,
  });
  await user.type(within(dialog).getByLabelText("Name"), "memory");
  await user.type(
    within(dialog).getByLabelText("Command"),
    "npx -y @modelcontextprotocol/server-memory",
  );
  await user.click(within(dialog).getByRole("button", { name: "Advanced" }));
  fireEvent.change(within(dialog).getByLabelText("Environment variables"), {
    target: { value: "API_KEY=secret\n\nnot-a-line\nFOO=bar" },
  });
  await user.click(
    within(dialog).getByRole("button", { name: "Add connector" }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    name: "memory",
    enabled: true,
    skipApprovals: false,
    server: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: { API_KEY: "secret", FOO: "bar" },
    },
  });
  expect(calls[0]?.server.url).toBeUndefined();

  expect(await screen.findByText("memory")).toBeInTheDocument();
});

it("adds a remote connector with OAuth/transport fields", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const calls: Connector[] = [];
  const spied: LykeionApi = {
    ...api,
    addConnector: (connector) => {
      calls.push(connector);
      return api.addConnector(connector);
    },
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(screen.getByRole("button", { name: /Add connector/i }));
  await user.click(screen.getByRole("menuitem", { name: /Remote URL/i }));

  const dialog = await screen.findByRole("dialog", {
    name: /add remote connector/i,
  });
  await user.type(within(dialog).getByLabelText("Name"), "acme");
  await user.type(
    within(dialog).getByLabelText(/Remote MCP server URL/i),
    "https://acme.example/mcp",
  );
  await user.click(within(dialog).getByRole("button", { name: "Advanced" }));
  await user.type(
    within(dialog).getByLabelText("OAuth Client ID"),
    "client-123",
  );
  await user.type(
    within(dialog).getByLabelText("OAuth Server URL"),
    "https://acme.example/oauth",
  );
  await user.type(within(dialog).getByLabelText("Scopes"), "read write");
  await user.type(
    within(dialog).getByLabelText("Headers helper command"),
    "acme-auth-helper",
  );
  await user.selectOptions(within(dialog).getByLabelText("Transport"), "sse");
  await user.click(
    within(dialog).getByRole("button", { name: "Add connector" }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    name: "acme",
    enabled: true,
    skipApprovals: false,
    server: {
      url: "https://acme.example/mcp",
      transport: "sse",
      oauthServerUrl: "https://acme.example/oauth",
      clientId: "client-123",
      scopes: "read write",
      headersHelper: "acme-auth-helper",
      args: [],
      env: {},
    },
  });
  expect(calls[0]?.server.command).toBeUndefined();
});

it("adds a remote connector with the default transport, which must be CLI-valid `http`", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const calls: Connector[] = [];
  const spied: LykeionApi = {
    ...api,
    addConnector: (connector) => {
      calls.push(connector);
      return api.addConnector(connector);
    },
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(screen.getByRole("button", { name: /Add connector/i }));
  await user.click(screen.getByRole("menuitem", { name: /Remote URL/i }));

  const dialog = await screen.findByRole("dialog", {
    name: /add remote connector/i,
  });
  await user.type(within(dialog).getByLabelText("Name"), "acme");
  await user.type(
    within(dialog).getByLabelText(/Remote MCP server URL/i),
    "https://acme.example/mcp",
  );
  // No manual transport pick — leave the Advanced select at its default.
  await user.click(
    within(dialog).getByRole("button", { name: "Add connector" }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.server.transport).toBe("http");
});

it("labels the transport options 'Streamable HTTP' / 'SSE' but emits the CLI-valid value", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openConnectors(user);

  await user.click(screen.getByRole("button", { name: /Add connector/i }));
  await user.click(screen.getByRole("menuitem", { name: /Remote URL/i }));
  const dialog = await screen.findByRole("dialog", {
    name: /add remote connector/i,
  });
  await user.click(within(dialog).getByRole("button", { name: "Advanced" }));

  const select = within(dialog).getByLabelText(
    "Transport",
  ) as HTMLSelectElement;
  const options = Array.from(select.options).map((o) => ({
    value: o.value,
    label: o.text,
  }));
  expect(options).toEqual([
    { value: "http", label: "Streamable HTTP" },
    { value: "sse", label: "SSE" },
  ]);
  expect(select.value).toBe("http");
});

it("blocks adding a connector whose name would desync the mcp.json/skip-approvals keys", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const calls: Connector[] = [];
  const spied: LykeionApi = {
    ...api,
    addConnector: (connector) => {
      calls.push(connector);
      return api.addConnector(connector);
    },
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(screen.getByRole("button", { name: /Add connector/i }));
  await user.click(screen.getByRole("menuitem", { name: /Local command/i }));
  const dialog = await screen.findByRole("dialog", {
    name: /add local connector/i,
  });

  await user.type(within(dialog).getByLabelText("Name"), "PubMed Search");
  await user.type(
    within(dialog).getByLabelText("Command"),
    "npx -y server-memory",
  );

  expect(
    within(dialog).getByRole("button", { name: "Add connector" }),
  ).toBeDisabled();
  expect(
    await within(dialog).findByText(/letters, digits, - and _/i),
  ).toBeInTheDocument();

  await user.click(
    within(dialog).getByRole("button", { name: "Add connector" }),
  );
  expect(calls).toHaveLength(0);
});

it("toggles a connector's enabled state", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const calls: [string, boolean][] = [];
  const spied: LykeionApi = {
    ...api,
    setConnectorEnabled: (name, enabled) => {
      calls.push([name, enabled]);
      return api.setConnectorEnabled(name, enabled);
    },
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(
    await screen.findByRole("switch", { name: /disable pubmed/i }),
  );
  expect(calls).toEqual([["pubmed", false]]);
});

it("expands a connector to show skip-approvals and its tools", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const calledWith: string[] = [];
  const spied: LykeionApi = {
    ...api,
    listConnectorTools: (name) => {
      calledWith.push(name);
      return api.listConnectorTools(name);
    },
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(
    await screen.findByRole("button", { name: /expand pubmed/i }),
  );

  expect(
    await screen.findByRole("switch", { name: /skip approvals for pubmed/i }),
  ).toBeInTheDocument();
  expect(await screen.findByText("search")).toBeInTheDocument();
  expect(calledWith).toEqual(["pubmed"]);
});

it("calls setConnectorSkipApprovals from the detail toggle", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const calls: [string, boolean][] = [];
  const spied: LykeionApi = {
    ...api,
    setConnectorSkipApprovals: (name, skip) => {
      calls.push([name, skip]);
      return api.setConnectorSkipApprovals(name, skip);
    },
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(
    await screen.findByRole("button", { name: /expand pubmed/i }),
  );
  await user.click(
    await screen.findByRole("switch", { name: /skip approvals for pubmed/i }),
  );

  expect(calls).toEqual([["pubmed", true]]);
});

it("shows the error text when tool discovery rejects", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const spied: LykeionApi = {
    ...api,
    listConnectorTools: () => Promise.reject(new Error("boom")),
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(
    await screen.findByRole("button", { name: /expand pubmed/i }),
  );
  expect(await screen.findByText("boom")).toBeInTheDocument();
});

it("shows a gentler note for the remote-not-supported error", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const spied: LykeionApi = {
    ...api,
    listConnectorTools: () =>
      Promise.reject(
        new Error("remote connector tool discovery is not yet supported"),
      ),
  };
  render(<App api={spied} />);
  await openConnectors(user);

  await user.click(
    await screen.findByRole("button", { name: /expand pubmed/i }),
  );
  expect(
    await screen.findByText(
      /Tool preview isn.t available for remote connectors yet/i,
    ),
  ).toBeInTheDocument();
});
