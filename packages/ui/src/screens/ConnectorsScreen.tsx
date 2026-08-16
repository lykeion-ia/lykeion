import { useState } from "react";
import type { CatalogEntry, Connector, McpServer, McpTool } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { ActionMenu, type ActionMenuItem } from "../components/ui/ActionMenu";
import { Toggle } from "../components/ui/Toggle";
import { AddConnectorModal } from "../components/connectors/AddConnectorModal";
import {
  GlobeIcon,
  LinkIcon,
  PlusIcon,
  TerminalIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "../components/icons";
import { primaryActionClass } from "../components/ui/PrimaryButton";
import { SettingsSectionHeader } from "../components/settings/SettingsSection";
import { cn } from "../lib/utils";

/** The reasons discovery is unavailable rather than broken. Both are the
 *  contract saying so plainly — one for a remote server, one for a lab with
 *  no machine attached — and neither is a failure to paint in red. */
const DISCOVERY_UNAVAILABLE = [
  "remote connector tool discovery is not yet supported",
  "no machine is connected to this lab",
];

/** The MCP server shape, shown compactly: `command args…` or the remote url. */
function ServerBadge({ server }: { server: McpServer }) {
  const label = server.url
    ? server.url
    : [server.command, ...server.args].filter(Boolean).join(" ");
  return (
    <span
      className="truncate font-mono text-meta text-fg-tertiary"
      title={label}
    >
      {label}
    </span>
  );
}

/**
 * Connectors — attached MCP servers + a curated catalog. Rendered as the
 * Settings › Capabilities › Connectors tab (and by the `#/connectors` alias,
 * which redirects there).
 *
 * Leads with `SettingsSectionHeader` rather than the section screens'
 * `ScreenHeader`, so its title sits on exactly the same baseline as Memory /
 * Compute / Network. The gutter and the scroll come from the settings pane —
 * this panel adds neither.
 */
export function ConnectorsScreen() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);
  const yours = usePromise(() => api.listConnectors(), [api, nonce]);
  const catalog = usePromise(() => api.connectorCatalog(), [api]);
  const [adding, setAdding] = useState<string | null>(null);
  const [addForm, setAddForm] = useState<"remote" | "local" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const yourList: Connector[] = yours.data ?? [];
  const yourNames = new Set(yourList.map((c) => c.name));

  const add = async (entry: CatalogEntry) => {
    setAdding(entry.name);
    try {
      await api.addConnector({
        name: entry.name,
        description: entry.description,
        server: entry.server,
        enabled: true,
        skipApprovals: false,
      });
      reload();
    } finally {
      setAdding(null);
    }
  };

  // Wired here (not at module scope) so the two setup paths can open the
  // matching Add form; "Browse" stays an external link (no onSelect).
  const connectorMenu: ActionMenuItem[] = [
    {
      id: "remote",
      icon: LinkIcon,
      label: "Remote URL",
      detail: "Connect a web MCP server",
      onSelect: () => setAddForm("remote"),
    },
    {
      id: "local",
      icon: TerminalIcon,
      label: "Local command",
      detail: "Run a local MCP server on this machine",
      onSelect: () => setAddForm("local"),
    },
    {
      id: "browse",
      icon: GlobeIcon,
      label: "Browse Connectors Directory",
      external: true,
      separatorBefore: true,
    },
  ];

  return (
    <div>
      <SettingsSectionHeader
        title="Connectors"
        action={
          <ActionMenu
            items={connectorMenu}
            align="end"
            width="w-72"
            className="shrink-0"
          >
            {({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                className={primaryActionClass}
              >
                <PlusIcon width={14} height={14} />
                Add connector
                <ChevronDownIcon
                  width={14}
                  height={14}
                  className="text-white/80"
                />
              </button>
            )}
          </ActionMenu>
        }
      />

      <div>
        <section data-testid="your-connectors" className="mb-6">
          <h2 className="mb-2 text-meta font-semibold uppercase tracking-[0.4px] text-fg-tertiary">
            Your connectors
          </h2>
          {yours.error && (
            <p className="text-ui text-danger">{yours.error}</p>
          )}
          {yours.loading ? null : yourList.length === 0 ? (
            <p className="py-4 text-ui text-fg-subtle">
              No connectors yet — add one from the catalog below.
            </p>
          ) : (
            <div>
              {yourList.map((connector) => (
                <ConnectorRow
                  key={connector.name}
                  connector={connector}
                  expanded={expanded === connector.name}
                  onToggleExpand={() =>
                    setExpanded((cur) =>
                      cur === connector.name ? null : connector.name,
                    )
                  }
                  onSetEnabled={async (next) => {
                    await api.setConnectorEnabled(connector.name, next);
                    reload();
                  }}
                  onSetSkipApprovals={async (next) => {
                    await api.setConnectorSkipApprovals(connector.name, next);
                    reload();
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section data-testid="connector-catalog">
          <h2 className="mb-2 text-meta font-semibold uppercase tracking-[0.4px] text-fg-tertiary">
            Catalog
          </h2>
          {catalog.error && (
            <p className="text-ui text-danger">{catalog.error}</p>
          )}
          <div>
            {(catalog.data ?? []).map((entry) => {
              const added = yourNames.has(entry.name);
              return (
                <div
                  key={entry.name}
                  className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-read text-fg">{entry.name}</span>
                    <span className="truncate text-sub text-fg-subtle">
                      {entry.description}
                    </span>
                    <ServerBadge server={entry.server} />
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-meta text-fg-subtle">
                      {entry.category}
                    </span>
                    <button
                      type="button"
                      aria-label={`Add ${entry.name}`}
                      disabled={added || adding === entry.name}
                      onClick={() => add(entry)}
                      className={cn(
                        "rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sub text-fg hover:bg-surface-3",
                        (added || adding === entry.name) &&
                          "cursor-not-allowed opacity-50",
                      )}
                    >
                      {added ? "Added" : "Add"}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {addForm && (
        <AddConnectorModal
          kind={addForm}
          onCreate={async (connector) => {
            await api.addConnector(connector);
            reload();
          }}
          onClose={() => setAddForm(null)}
        />
      )}
    </div>
  );
}

/**
 * One "Your connectors" row: name/description + server badge + the enable
 * switch, expandable (chevron / row body, not the switch) into the detail
 * pane. Mirrors `CapabilityList`'s toggle-in-a-list pattern (see
 * `SkillsScreen`), plus the expand affordance this screen adds.
 */
function ConnectorRow({
  connector,
  expanded,
  onToggleExpand,
  onSetEnabled,
  onSetSkipApprovals,
}: {
  connector: Connector;
  expanded: boolean;
  onToggleExpand: () => void;
  onSetEnabled: (next: boolean) => void;
  onSetSkipApprovals: (next: boolean) => void;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex items-center justify-between gap-4 py-2.5">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${connector.name}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRightIcon
            width={14}
            height={14}
            className={cn(
              "shrink-0 text-fg-subtle transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span
            className={cn(
              "flex min-w-0 flex-col",
              !connector.enabled && "opacity-50",
            )}
          >
            <span className="text-read text-fg">{connector.name}</span>
            <span className="truncate text-sub text-fg-subtle">
              {connector.description}
            </span>
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-3">
          <ServerBadge server={connector.server} />
          <Toggle
            on={connector.enabled}
            onToggle={onSetEnabled}
            ariaLabel={`${connector.enabled ? "Disable" : "Enable"} ${connector.name}`}
          />
        </span>
      </div>
      {expanded && (
        <ConnectorDetail
          connector={connector}
          onSetSkipApprovals={onSetSkipApprovals}
        />
      )}
    </div>
  );
}

/**
 * The inline-expand detail: the skip-approvals toggle + a live, read-only
 * tools list (`listConnectorTools`, lazy — fetched on mount, i.e. on first
 * expand). The proactive per-tool allow/ask/deny grid is explicitly out of
 * scope for this task; per-tool grants still work at run time via the
 * approval card.
 */
function ConnectorDetail({
  connector,
  onSetSkipApprovals,
}: {
  connector: Connector;
  onSetSkipApprovals: (next: boolean) => void;
}) {
  const api = useApi();
  const tools = usePromise<McpTool[]>(
    () => api.listConnectorTools(connector.name),
    [api, connector.name],
  );

  return (
    <div className="mb-3 ml-6 flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col">
          <span className="text-ui font-medium text-fg">
            Skip approvals
          </span>
          <span className="text-sub text-fg-subtle">
            Allow the agent to use every tool from this connector without an
            approval card each time.
          </span>
        </span>
        <Toggle
          on={connector.skipApprovals}
          onToggle={onSetSkipApprovals}
          ariaLabel={`Skip approvals for ${connector.name}`}
        />
      </div>

      <div>
        <h3 className="mb-1.5 text-meta font-semibold uppercase tracking-[0.4px] text-fg-tertiary">
          Tools
        </h3>
        {tools.loading && (
          <p className="text-sub text-fg-subtle">Discovering tools…</p>
        )}
        {tools.error &&
          (DISCOVERY_UNAVAILABLE.some((reason) => tools.error!.includes(reason)) ? (
            <p className="text-sub text-fg-subtle">
              Tool preview isn&rsquo;t available for remote connectors yet (they
              still run).
            </p>
          ) : (
            <p className="text-sub text-danger">{tools.error}</p>
          ))}
        {tools.data && tools.data.length === 0 && (
          <p className="text-sub text-fg-subtle">No tools reported.</p>
        )}
        {tools.data && tools.data.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {tools.data.map((tool) => (
              <div
                key={tool.name}
                className="rounded-md border border-line bg-surface px-2.5 py-1.5"
              >
                <p className="font-mono text-sub text-fg">{tool.name}</p>
                {tool.description && (
                  <p className="text-sub text-fg-subtle">
                    {tool.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ConnectorsScreen;
