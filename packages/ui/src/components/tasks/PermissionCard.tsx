import { useEffect, useRef, useState } from "react";
import type {
  AccessKind,
  PermissionRequest,
  PermissionScope,
} from "@lykeion/api";
import { CodeBlock } from "./CodeBlock";
import { ChevronDownIcon } from "../icons";
import { scopesFor, defaultScopeFor } from "../../lib/permission-scopes";
import { useOutsideClick } from "../../hooks/useOutsideClick";

/**
 * A list of names as a person would say it: "scanpy", "scanpy and anndata",
 * "scanpy, anndata and scipy". What goes in a card's headline, where a
 * bracketed array would read as a data structure rather than as a sentence.
 */
function spoken(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The card's code block always wants a plain string. Every `AccessKind`
 * target already is one except two: `connector`, whose target is a
 * `{ server, tool }` pair — rendered as `server: tool` — and `environment`,
 * whose target names an environment and the packages going into it. Those
 * render one per line, because the package list IS what is being approved
 * and a comma-run of forty of them is not something a person reads.
 */
function accessCode(access: AccessKind): string {
  if (access.kind === "connector")
    return `${access.target.server}: ${access.target.tool}`;
  if (access.kind === "environment")
    return access.target.packages.length === 0
      ? `${access.target.name} — no packages, the interpreter only`
      : access.target.packages.join("\n");
  return access.target;
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
 *
 * The `environment` kind is the one that needs the TOOL as well as the
 * access. Declaring a new environment and adding packages to one that
 * already exists are the same kind — the same fact is being consented to,
 * software on every machine in this lab — but they are not the same
 * question, and a card that asked one of them in the other's words would
 * have a researcher approve the wrong thing.
 */
function accessTitle(access: AccessKind, tool: string): string {
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
    case "environment": {
      // How this lab says the language, or nothing at all. Empty where the
      // daemon sent none — a session this machine never described that
      // environment to, or one configured by a daemon older than the field —
      // because a card naming a language it was never told is worse than one
      // naming none.
      const said =
        access.target.language === undefined
          ? ""
          : access.target.language === "r"
            ? "R"
            : "Python";
      if (tool === "manage_environments")
        // The language leads the noun where the daemon sent one, because
        // the name does not carry it. `crispr` is a name a researcher chose
        // and says nothing about which package set is about to be installed
        // on every machine in this lab. The list below usually hints — and
        // an environment holding only its interpreter has no list at all,
        // which is the card with the least on it and the most to get wrong.
        // Silent where nothing was sent, rather than guessing Python: a
        // daemon older than the R phase says nothing, and a card that
        // named a language it was never told would be worse than one that
        // names none.
        return said === ""
          ? `Create environment ${access.target.name}?`
          : `Create ${said} environment ${access.target.name}?`;
      // Adding to an environment that already exists. An empty package list
      // is not a request anything raises — `manage_packages` refuses one by
      // value — but it must still not render as "Add  to python?", so the
      // environment's own name carries the question instead.
      //
      // The language belongs on THIS card at least as much as on the create
      // one: creating declares a name and installs nothing, while this puts
      // software on every machine in the lab. It read "Add ggplot2 to
      // rstats?" and said nothing about what `rstats` is.
      return access.target.packages.length === 0
        ? `Change the ${said === "" ? "" : `${said} `}${access.target.name} environment?`
        : `Add ${spoken(access.target.packages)} to ${said === "" ? "" : `the ${said} environment `}${access.target.name}?`;
    }
  }
}

/**
 * The payload disclosure's label, and whether it starts open.
 *
 * Open for a shell command ("Code") because the command IS what is being
 * approved and approving what you cannot see is not consent. Open for an
 * environment ("Packages") for exactly the same reason: the title names one
 * or two of them at most, and what actually gets installed on every machine
 * in the lab is the whole list. Closed for every other kind ("Details")
 * because the title already names the target — the disclosure holds the raw
 * form, not the decision.
 */
function payloadLabel(access: AccessKind): { label: string; open: boolean } {
  if (access.kind === "execute") return { label: "Code", open: true };
  if (access.kind === "environment") return { label: "Packages", open: true };
  return { label: "Details", open: false };
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
 * 3. The initial `selectedScope` is `defaultScopeFor(access)` — "conversation"
 *    for most cards, "once" for an environment. The `Allow` button's label
 *    renders FROM this state, so the default has to be an explicit value the
 *    researcher can read ("Allow for this conversation") before ever opening
 *    the menu.
 * 4. Which scopes the menu offers is `scopesFor(access)`, not the whole
 *    list. An environment card offers no standing grant at all — see that
 *    function for why. This is a narrowing of what is OFFERED; the daemon
 *    refuses a broader scope on its own account, because a decision arrives
 *    over the wire and this component is not a guard.
 */
export function PermissionCard({
  request,
  queue,
  onAllow,
  onDeny,
}: {
  request: PermissionRequest;
  /** Where this card sits in a batch of gates the turn raised at once, when
   *  there is more than one. Absent for a lone card. */
  queue?: { position: number; total: number } | null;
  onAllow: (scope: PermissionScope) => void;
  onDeny: () => void;
}) {
  const [selectedScope, setSelectedScope] = useState<PermissionScope>(
    defaultScopeFor(request.access),
  );
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
      {/* What ELSE this turn is waiting to ask. A researcher deciding the
          first of four calls is deciding one of four, and a card that said
          nothing would let them answer it believing it was the whole request.
          The visible chip is short; the sentence beside it is for a screen
          reader, which a bare "1 of 4" tells nothing at all. */}
      {queue && (
        <div className="perm-queue" data-testid="perm-queue">
          <span aria-hidden="true">
            {queue.position} of {queue.total}
          </span>
          <span className="sr-only">
            Decision {queue.position} of {queue.total} this turn is asking for.
          </span>
        </div>
      )}

      {/* The headline names what is about to happen, as a question. The old
          "Permission requested" eyebrow said only THAT consent was wanted, never
          for what — the target lived in the code block alone. */}
      <h3 className="perm-title">
        {accessTitle(request.access, request.tool)}
      </h3>

      {/* The agent's own reason for asking, attributed as such: it is the
          agent's claim about why this is needed, not the app's assurance that
          it is safe.

          Not for an environment card, which carries a `detail` that is not one
          of those. `manage_environments` publishes no "why" argument, so
          nothing an agent said could arrive here; what the daemon puts there
          is a one-line name for the decision, so the researcher reading their
          transcript back sees which environment they answered for rather than
          a row saying only that they answered. Rendered here it would
          attribute a description to the agent as a justification, and say for
          the third time — after the question above and the package list below
          — what is already on screen twice. */}
      {request.detail && request.access.kind !== "environment" && (
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
              {scopesFor(request.access).map(({ scope, label, description }) => (
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
