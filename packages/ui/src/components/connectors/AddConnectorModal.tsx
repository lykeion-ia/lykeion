import { useEffect, useState, type FormEvent } from "react";
import type { Connector, McpServer } from "@lykeion/api";
import { ChevronDownIcon, CloseIcon } from "../icons";
import { cn } from "../../lib/utils";

// Values, not labels, must be what the `claude` CLI accepts for a remote MCP
// server's `type` — `http` / `sse` / `ws` only, never `streamable-http`.
const TRANSPORTS = [
  { value: "http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
] as const;

/**
 * The connector name becomes the `.mcp.json` server key, the `<server>` in
 * `mcp__<server>__<tool>`, and the `connector_all(name)` skip-approvals grant
 * key — it must round-trip byte-identically through all three, so it's
 * constrained to what stays identical across all of them.
 */
function validConnectorName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name) && !name.includes("__");
}

const LABEL = "text-sub font-medium text-fg-muted";
const INPUT =
  "w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong";

/**
 * Split a shell-command string into `command` + `args` (the Local form).
 *
 * v1: a naive whitespace split, no shell-quote handling — a quoted arg with
 * spaces (`--label "two words"`) won't survive intact. Good enough for the
 * common `npx -y @scope/pkg` shape; revisit if users need quoting.
 */
function splitCommand(input: string): { command: string; args: string[] } {
  const [command = "", ...args] = input.trim().split(/\s+/).filter(Boolean);
  return { command, args };
}

/** Parse `KEY=value` lines into an env map, skipping blank lines and lines with no `=`. */
function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no '=', or an empty key
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    env[key] = line.slice(eq + 1).trim();
  }
  return env;
}

export interface AddConnectorModalProps {
  kind: "remote" | "local";
  onCreate: (connector: Connector) => Promise<void>;
  onClose: () => void;
}

/**
 * The Add-connector form behind the Connectors screen's "Remote URL" / "Local
 * command" menu items — one modal, two field sets. `onCreate`
 * receives a fully-formed `Connector` (`enabled: true, skipApprovals: false`
 * — always true for a brand-new attach); the caller just persists it and
 * reloads the list. Styled after `CreateAgentModal`.
 */
export function AddConnectorModal({
  kind,
  onCreate,
  onClose,
}: AddConnectorModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Remote fields
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<
    (typeof TRANSPORTS)[number]["value"]
  >(TRANSPORTS[0].value);
  const [oauthServerUrl, setOauthServerUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState("");
  const [headersHelper, setHeadersHelper] = useState("");

  // Local fields
  const [command, setCommand] = useState("");
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length > 0 && !validConnectorName(trimmedName)
      ? 'Name must use only letters, digits, - and _ (no spaces, dots, or "__").'
      : null;

  const canSubmit =
    trimmedName.length > 0 &&
    validConnectorName(trimmedName) &&
    (kind === "remote" ? url.trim().length > 0 : command.trim().length > 0) &&
    !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const server: McpServer =
        kind === "remote"
          ? {
              url: url.trim(),
              transport,
              oauthServerUrl: oauthServerUrl.trim() || undefined,
              clientId: clientId.trim() || undefined,
              scopes: scopes.trim() || undefined,
              headersHelper: headersHelper.trim() || undefined,
              args: [],
              env: {},
            }
          : { ...splitCommand(command), env: parseEnvLines(envText) };
      await onCreate({
        name: trimmedName,
        description: description.trim(),
        server,
        enabled: true,
        skipApprovals: false,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={
          kind === "remote" ? "Add remote connector" : "Add local connector"
        }
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[520px] flex-col rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-read font-semibold text-fg">
            {kind === "remote" ? "Add remote connector" : "Add local connector"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>
        <p className="px-5 text-ui text-fg-subtle">
          Only add connectors from developers you trust — a connector&rsquo;s
          server can read data and take actions on the agent&rsquo;s behalf.
        </p>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-3 overflow-y-auto px-5 py-4">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. PubMed"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={nameError ? true : undefined}
                className={INPUT}
              />
              {nameError && (
                <span className="text-sub text-danger">{nameError}</span>
              )}
            </label>

            {kind === "remote" ? (
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Remote MCP server URL</span>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  autoComplete="off"
                  spellCheck={false}
                  className={INPUT}
                />
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Command</span>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx -y @modelcontextprotocol/server-memory"
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(INPUT, "font-mono")}
                />
              </label>
            )}

            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="flex items-center gap-1.5 self-start text-sub font-medium text-fg-muted hover:text-fg"
            >
              <ChevronDownIcon
                width={13}
                height={13}
                className={cn(
                  "transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
              Advanced
            </button>

            {advancedOpen && (
              <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 p-3">
                {kind === "remote" ? (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>OAuth Client ID</span>
                      <input
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        autoComplete="off"
                        className={INPUT}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>OAuth Server URL</span>
                      <input
                        value={oauthServerUrl}
                        onChange={(e) => setOauthServerUrl(e.target.value)}
                        autoComplete="off"
                        className={INPUT}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>Scopes</span>
                      <input
                        value={scopes}
                        onChange={(e) => setScopes(e.target.value)}
                        placeholder="space-separated"
                        autoComplete="off"
                        className={INPUT}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>Headers helper command</span>
                      <input
                        value={headersHelper}
                        onChange={(e) => setHeadersHelper(e.target.value)}
                        autoComplete="off"
                        className={cn(INPUT, "font-mono")}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className={LABEL}>Transport</span>
                      <select
                        value={transport}
                        onChange={(e) =>
                          setTransport(
                            e.target
                              .value as (typeof TRANSPORTS)[number]["value"],
                          )
                        }
                        className={INPUT}
                      >
                        {TRANSPORTS.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : (
                  <label className="flex flex-col gap-1">
                    <span className={LABEL}>Environment variables</span>
                    <textarea
                      value={envText}
                      onChange={(e) => setEnvText(e.target.value)}
                      placeholder={"KEY=value"}
                      rows={3}
                      spellCheck={false}
                      className={cn(INPUT, "resize-none font-mono")}
                    />
                  </label>
                )}
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Description</span>
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    autoComplete="off"
                    className={INPUT}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-ui text-fg-muted hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className={cn(
                "rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity",
                canSubmit
                  ? "hover:opacity-90"
                  : "cursor-not-allowed opacity-50",
              )}
            >
              Add connector
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddConnectorModal;
