import { useEffect, useRef, useState } from "react";
import type {
  AccessKind,
  PermissionRequest,
  PermissionScope,
} from "@lykeion/api";
import { CodeBlock } from "./CodeBlock";
import { ChevronDownIcon } from "../icons";
import { PERMISSION_SCOPES, DEFAULT_SCOPE } from "../../lib/permission-scopes";
import { useOutsideClick } from "../../hooks/useOutsideClick";

/**
 * The card's code block always wants a plain string. Every `AccessKind`
 * target already is one except `connector`, whose target is a
 * `{ server, tool }` pair — render that as `server: tool`.
 */
function accessCode(access: AccessKind): string {
  return access.kind === "connector"
    ? `${access.target.server}: ${access.target.tool}`
    : access.target;
}

/**
 * The card's headline, as a question naming what is about to happen: "Run a
 * shell command?", "Connect to www.addgene.org?".
 *
 * Where the TARGET is the consequential fact (a network host, a file, a
 * connector tool) the title names it, so the thing being approved is legible
 * before any disclosure is opened. A shell command is the exception: it is far
 * too long for a title, so the question stays generic and the command itself
 * renders expanded below (see `payloadLabel`).
 */
function accessTitle(access: AccessKind): string {
  switch (access.kind) {
    case "network":
      return `Connect to ${access.target}?`;
    case "execute":
      return "Run a shell command?";
    case "write-path":
      return `Write ${access.target}?`;
    case "read-path":
      return `Read ${access.target}?`;
    case "connector":
      return `Use ${access.target.server} · ${access.target.tool}?`;
    case "remote-job":
      return `Submit a remote job to ${access.target}?`;
  }
}

/**
 * The payload disclosure's label, and whether it starts open.
 *
 * Open for a shell command ("Code") because the command IS what is being
 * approved and approving what you cannot see is not consent. Closed for
 * every other kind ("Details") because the title already names the target —
 * the disclosure holds the raw form, not the decision.
 */
function payloadLabel(access: AccessKind): { label: string; open: boolean } {
  return access.kind === "execute"
    ? { label: "Code", open: true }
    : { label: "Details", open: false };
}

/**
 * The `Allow` button's label suffix for each scope, e.g. "Allow " + "for this
 * conversation". Kept separate from `PERMISSION_SCOPES`' own `label` (the
 * menu row's wording, "This conversation") because the button reads as one
 * sentence ("Allow for this conversation") rather than repeating the menu's
 * noun phrase after the verb.
 */
const ALLOW_SUFFIX: Record<PermissionScope, string> = {
  once: "once",
  conversation: "for this conversation",
  study: "for this Study",
  global: "globally",
};

/**
 * A permission card — the surface's most consequential control, built as a
 * split-button approval block rather than four equal-weight scope buttons.
 *
 * Three decisions, each load-bearing:
 *
 * 1. The requested command is always visible, never behind a disclosure — it
 *    renders in `CodeBlock` on first paint, no interaction required.
 *    Approving what you cannot see is not consent.
 * 2. The scope menu only SETS `selectedScope` and closes; it never grants.
 *    Granting stays a deliberate click on `Allow` → `onAllow(selectedScope)`.
 *    A menu whose rows each granted immediately would turn one stray click
 *    into a `Global` grant.
 * 3. The initial `selectedScope` is `DEFAULT_SCOPE` ("conversation"), not
 *    "once". The `Allow` button's label renders FROM this state, so the
 *    default has to be an explicit value the researcher can read ("Allow for
 *    this conversation") before ever opening the menu.
 */
export function PermissionCard({
  request,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest;
  onAllow: (scope: PermissionScope) => void;
  onDeny: () => void;
}) {
  const [selectedScope, setSelectedScope] =
    useState<PermissionScope>(DEFAULT_SCOPE);
  const [menuOpen, setMenuOpen] = useState(false);
  // A shell command starts visible; every other payload starts folded away.
  const [payloadOpen, setPayloadOpen] = useState(
    payloadLabel(request.access).open,
  );
  const groupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useOutsideClick(groupRef, () => setMenuOpen(false), menuOpen);

  // Escape closes the menu AND returns focus to the trigger — the
  // disclosure-widget pattern WCAG requires; a menu that swallows focus on
  // close would strand a keyboard user.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="card perm-card">
      {/* The headline names what is about to happen, as a question. The old
          "Permission requested" eyebrow said only THAT consent was wanted, never
          for what — the target lived in the code block alone. */}
      <h3 className="perm-title">{accessTitle(request.access)}</h3>

      {/* The agent's own reason for asking, attributed as such: it is the
          agent's claim about why this is needed, not the app's assurance that it
          is safe. */}
      {request.detail && (
        <>
          <div className="perm-detail">{request.detail}</div>
          <div className="perm-detail-source">Agent-supplied reason.</div>
        </>
      )}

      {/* Decision 1 still holds: for a shell command the code is EXPANDED on
          first paint (approving what you cannot see is not consent). For every
          other kind the title already names the target, so the raw form sits
          behind the disclosure instead of shouting a bare hostname twice. */}
      <details
        className="perm-payload"
        open={payloadOpen}
        onToggle={(e) => setPayloadOpen(e.currentTarget.open)}
      >
        <summary className="perm-payload-summary">
          {payloadLabel(request.access).label}
        </summary>
        <CodeBlock
          code={accessCode(request.access)}
          lang={request.access.kind === "execute" ? "bash" : undefined}
        />
        <div className="perm-meta">
          <span className="perm-tool">{request.tool}</span>
        </div>
      </details>
      <div className="card-actions perm-actions">
        <div className="perm-allow-group" ref={groupRef}>
          <button
            type="button"
            className="btn btn--primary perm-allow-btn"
            onClick={() => onAllow(selectedScope)}
          >
            Allow {ALLOW_SUFFIX[selectedScope]}
          </button>
          <button
            type="button"
            ref={triggerRef}
            className="btn btn--primary perm-scope-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Choose approval scope"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <ChevronDownIcon width={10} height={10} />
          </button>
          {menuOpen && (
            <div
              className="perm-scope-menu"
              role="menu"
              aria-label="Approval scope"
            >
              {PERMISSION_SCOPES.map(({ scope, label, description }) => (
                <button
                  key={scope}
                  type="button"
                  role="menuitemradio"
                  aria-checked={scope === selectedScope}
                  aria-label={label}
                  className={`perm-scope-item${
                    scope === selectedScope ? " is-selected" : ""
                  }`}
                  // Decision 2: selecting a scope only sets it — it does NOT
                  // grant. Granting stays a deliberate click on `Allow`.
                  onClick={() => {
                    setSelectedScope(scope);
                    setMenuOpen(false);
                  }}
                >
                  <span className="perm-scope-item-label">{label}</span>
                  <span className="perm-scope-item-desc">{description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="btn btn--danger" onClick={onDeny}>
          Deny
        </button>
      </div>
    </div>
  );
}

export default PermissionCard;
