/**
 * The customization-engine contract. Field names and encodings are the wire
 * format exactly (camelCase).
 *
 * Everything here is a first-class on-disk file under the Lab, agent-agnostic
 * by nature: Skills (SKILL.md packs), Agents (persona Markdown), Workflows
 * (JSON prompt-templates), and Connectors (MCP server configs) + a curated
 * catalog of scientific databases.
 */

import { LykeionError } from "./errors";
import type { Discipline, MethodPhase } from "./types";

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

/** One fillable slot in a Workflow's prompt template. */
export interface Placeholder {
  /** The `{key}` token in the prompt. */
  key: string;
  label: string;
  required: boolean;
  default?: string;
}

/** A Workflow: a research procedure, cut from the method spine. */
export interface Workflow {
  id: string;
  name: string;
  description: string;
  /** The field this procedure belongs to. The Workflows list groups on it. */
  discipline: Discipline;
  icon: string;
  /** The prompt, with `{placeholder}` tokens. */
  prompt: string;
  placeholders: Placeholder[];
  /**
   * This procedure's own ordered subset of `METHOD_PHASES` — a subsequence,
   * never a reordering. `METHOD_PHASE_SKILL` names the Skill behind each.
   */
  phases: MethodPhase[];
  suggestedSkills: string[];
  requiresFiles: boolean;
}

/**
 * Expand a Workflow's prompt against `values`: value, then default, then an
 * error when a required placeholder has neither. Unknown `{tokens}` are left
 * untouched.
 *
 * One definition rather than one per implementation — what a missing optional
 * placeholder expands to is a rule the browser core and the workspace server
 * have to agree on exactly, and two copies agree only by inspection.
 */
export function expandPrompt(
  workflow: Pick<Workflow, "prompt" | "placeholders">,
  values: Record<string, string>,
): string {
  let prompt = workflow.prompt;
  for (const ph of workflow.placeholders) {
    let value: string;
    if (values[ph.key] !== undefined) value = values[ph.key];
    else if (ph.default !== undefined) value = ph.default;
    else if (ph.required)
      throw new LykeionError(
        "invalid",
        `missing required placeholder ${ph.key}`,
      );
    else value = "";
    prompt = prompt.split(`{${ph.key}}`).join(value);
  }
  return prompt;
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
