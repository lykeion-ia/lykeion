/**
 * The customization-engine contract. Field names and encodings are the wire
 * format exactly (camelCase).
 *
 * Everything here is a first-class on-disk file under the Lab, agent-agnostic
 * by nature: Skills (SKILL.md packs), Agents (persona Markdown), and
 * Connectors (MCP server configs) + a curated catalog of scientific
 * databases.
 */

/** A Skill: reusable instructions the agent can load. */
export interface Skill {
  name: string;
  description: string;
  /** The Markdown body after the frontmatter. */
  body: string;
}

/**
 * A Skill plus whether it's currently enabled — flattened, so the shape is
 * flat: name/description/body/enabled.
 */
export interface SkillEntry {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}

/** An Agent / specialist persona. */
export interface Agent {
  name: string;
  description: string;
  /** The persona's system prompt (the Markdown body). */
  systemPrompt: string;
  model?: string;
  tools: string[];
  /**
   * Names of Connectors this persona is scoped to. A delegated subagent sees
   * only these, intersected with the Lab's enabled connectors; an empty list
   * inherits every enabled connector (narrowing, not additive).
   */
  connectors: string[];
}

/**
 * An MCP server config, Claude-Desktop shape: a stdio server (`command` +
 * `args`) or a remote `url` (+ transport and OAuth fields).
 */
export interface McpServer {
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  /** The remote transport (e.g. `"http"` / `"sse"`); stdio servers leave this unset. */
  transport?: string;
  /** The OAuth authorization server URL for a remote connector. */
  oauthServerUrl?: string;
  /** The OAuth client id registered with the authorization server. */
  clientId?: string;
  /** The OAuth scopes requested, space-separated. */
  scopes?: string;
  /** A shell command that prints request headers (e.g. a bearer token) as JSON to stdout. */
  headersHelper?: string;
}

/** A Connector: a named MCP server the workbench can attach. */
export interface Connector {
  name: string;
  description: string;
  server: McpServer;
  /** Whether this connector is active (a connector with no flag defaults to enabled). */
  enabled: boolean;
  /** When true, every tool on this connector is granted without an approval prompt. */
  skipApprovals: boolean;
}

/** A curated catalog entry — a scientific database, ready to add. */
export interface CatalogEntry {
  name: string;
  description: string;
  category: string;
  server: McpServer;
}

/**
 * One tool a connector's MCP server advertises via `tools/list`.
 * Discovery-only — this describes a tool, it never calls one.
 */
export interface McpTool {
  name: string;
  description?: string;
  /** The tool's JSON Schema (MCP `inputSchema`); opaque to the UI. */
  inputSchema: unknown;
}
