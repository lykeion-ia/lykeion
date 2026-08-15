export type PairingPageTone = "neutral" | "success" | "warning" | "refusal" | "error";

export interface PairingPageInput {
  title: string;
  tone: PairingPageTone;
  eyebrow: string;
  heading: string;
  description: string;
  contentHtml?: string;
  footer?: string;
}

const PAIRING_CSS = `
:root{color-scheme:dark;
/* The same five seeds the application derives its whole palette from — see
   packages/ui/src/styles/tokens.css — mixed here by the same formulas rather
   than matched by hand. These pages and the setup wizard are one first run
   seen either side of a redirect, and two hand-tuned palettes drift: the
   muted step here was #aeb1b6 against a computed #c6c7c9 there. */
--seed-bg:#0f0f10;--seed-ink:#eeeff1;--seed-surface:#151516;--seed-accent:#d25e65;
--canvas:var(--seed-bg);--surface:var(--seed-surface);--surface-2:color-mix(in srgb,var(--seed-surface) 92%,var(--seed-ink));
--ink:var(--seed-ink);--muted:color-mix(in srgb,var(--seed-ink) 82%,var(--seed-bg));--subtle:color-mix(in srgb,var(--seed-ink) 55%,var(--seed-bg));
--line:color-mix(in srgb,var(--seed-bg) 88%,var(--seed-ink));--line-strong:color-mix(in srgb,var(--seed-bg) 80%,var(--seed-ink));
--accent:var(--seed-accent);--success:#58be70;--warning:#d9a441;--danger:#e5705b;
font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{background:var(--canvas);color:var(--ink);overflow-wrap: anywhere}
/* The wizard's own frame (Wizard.tsx): one 560px column, its content centred
   in the space above, and a bordered strip beneath it when there is anything
   to put there. A refusal has nothing, so it gets no strip — a progress rule
   on a page where the flow stopped would draw movement that is not happening. */
.page{display:flex;min-height:100vh;flex-direction:column}
.frame{display:flex;flex:1;align-items:center;justify-content:center;padding:2.5rem 1.5rem}
.column{width:100%;max-width:560px}
.strip{border-top:1px solid var(--line);padding:1rem 1.5rem}
.strip .column{margin:0 auto;color:var(--subtle);font-size:.8125rem}
.brand{display:flex;align-items:center;gap:.5rem;font-size:.8125rem;font-weight:600;letter-spacing:.02em;color:var(--ink)}
.brand-mark{display:grid;place-items:center;width:1.5rem;height:1.5rem;border-radius:.45rem;background:var(--accent);color:#fff}
h1{margin:1.75rem 0 0;color:var(--ink);font-size:2rem;font-weight:600;line-height:1.25;letter-spacing:-.03em}
.description{max-width:34rem;margin:.75rem 0 0;color:var(--muted);font-size:1rem;line-height:1.625}
.machine-summary{display:grid;gap:.5rem;margin:1.5rem 0 0;padding:.5rem;border:1px solid var(--line);border-radius:.75rem;background:var(--surface)}.machine-summary>div{display:grid;grid-template-columns:minmax(0,8rem) minmax(0,1fr);gap:1rem;padding:.5rem}.machine-summary>div+div{border-top:1px solid var(--line)}.machine-summary dt{color:var(--muted);font:600 .8125rem/1.4 ui-monospace,"SF Mono",monospace;letter-spacing:.08em;text-transform:uppercase}.machine-summary dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.lab-link{display:inline-block;margin:1.5rem 0 0;border-radius:.375rem;background:var(--ink);color:var(--canvas);padding:.5rem .875rem;font-size:.9375rem;font-weight:500;text-decoration:none;overflow-wrap:anywhere}
/* Tone lives here now rather than in a coloured circle above the heading. The
   wizard has no such ornament, and the one thing on these pages that is
   genuinely about the tone is the way out. */
.recovery{margin:1.5rem 0 0;padding:.9rem 1rem;border:1px solid var(--line);border-left:3px solid var(--line-strong);border-radius:.65rem;background:var(--surface);color:var(--muted);font-size:.9375rem;line-height:1.6}
body[data-tone="success"] .recovery{border-left-color:var(--success)}body[data-tone="warning"] .recovery{border-left-color:var(--warning)}body[data-tone="refusal"] .recovery{border-left-color:var(--accent)}body[data-tone="error"] .recovery{border-left-color:var(--danger)}
.recovery code{padding:.15rem .35rem;border:1px solid var(--line);border-radius:.3rem;background:var(--surface-2);color:var(--ink);font:inherit;white-space:normal;overflow-wrap:anywhere}
.technical-detail{max-width:100%;margin:1.5rem 0 0;padding:1rem;border:1px solid var(--line);border-radius:.65rem;background:var(--surface);color:var(--muted);font:.8125rem/1.55 ui-monospace,"SF Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}
.setup-form{display:flex;flex-direction:column;gap:.75rem;margin:2rem 0 0}.field{display:flex;flex-direction:column;gap:.25rem}.field label{color:color-mix(in srgb,var(--seed-ink) 40%,var(--seed-bg));font-size:.8125rem;font-weight:500;letter-spacing:.4px;text-transform:uppercase}.field-help{margin:0;color:var(--subtle);font-size:.8125rem}.form-error{margin:0;color:var(--danger);font-size:.875rem}.form-error:empty{display:none}
input,button{font:inherit}input{width:100%;border:1px solid var(--line);border-radius:.375rem;background:var(--surface-2);color:var(--ink);padding:.375rem .5rem;font-size:.9375rem}input:focus{border-color:var(--line-strong);outline:none}
button{align-self:flex-start;margin-top:.25rem;border:0;border-radius:.375rem;background:var(--ink);color:var(--canvas);padding:.375rem .875rem;font-size:.9375rem;font-weight:500}button:disabled{cursor:wait;opacity:.4}
.agent[data-available="false"]{opacity:.55}.agent[data-available="false"] .agent-signin{cursor:not-allowed}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width: 420px){.frame{padding:1.5rem 1.25rem}h1{font-size:1.75rem}.machine-summary>div{grid-template-columns:1fr;gap:.25rem}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation: none !important;scroll-behavior:auto!important}}
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const command = (value: string) => `<code>${escapeHtml(value)}</code>`;
const recovery = (html: string) => `<div class="recovery">${html}</div>`;

function redactSensitiveValues(message: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((redacted, value) => redacted.split(value).join("[redacted]"), message);
}

export function renderPairingPage(input: PairingPageInput): string {
  const content = input.contentHtml ?? "";
  // The strip is the wizard's, and on a real step it carries the dots. A page
  // with nothing to put in it gets none: an empty bordered rule is furniture,
  // and a progress strip on a refusal would draw movement that has stopped.
  const strip = input.footer
    ? `<footer class="strip"><div class="column">${escapeHtml(input.footer)}</div></footer>`
    : "";
  // The eyebrow keeps its job and loses its weight. It said what kind of page
  // this is — "Pairing session unavailable" — which the wizard has no
  // equivalent of and which a screen reader still needs; the uppercase mono
  // label over a display-size heading is what made these read as another
  // product.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)} · Lykeion</title><style>${PAIRING_CSS}</style></head><body data-tone="${input.tone}"><main class="page"><div class="frame"><div class="column"><header class="brand" aria-label="Lykeion"><span class="brand-mark" aria-hidden="true">λ</span><span>Lykeion</span></header><p class="sr-only" role="status">${escapeHtml(input.eyebrow)}</p><h1>${escapeHtml(input.heading)}</h1><p class="description">${escapeHtml(input.description)}</p>${content}</div></div>${strip}</main></body></html>`;
}

export interface SetupPageInput {
  lab: string;
  machineName: string;
  challenge: string;
  state: string;
  platform: string;
  version: string;
  redirect: string;
}

function scriptValue(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderSetupPage(input: SetupPageInput): string {
  const form = `<form id="connect" class="setup-form">
    <div class="field"><label for="lab">Lykeion lab address</label><input id="lab" name="lab" type="url" value="${escapeHtml(input.lab)}" placeholder="http://127.0.0.1:1421" autocomplete="url" aria-describedby="lab-help" required><p id="lab-help" class="field-help">The address you use to open this Lykeion lab.</p></div>
    <div class="field"><label for="name">Machine name</label><input id="name" name="name" value="${escapeHtml(input.machineName)}" autocomplete="off" aria-describedby="name-help" required><p id="name-help" class="field-help">This is how the machine will appear in Runtimes.</p></div>
    <p id="form-error" role="alert" aria-live="polite" class="form-error" tabindex="-1"></p>
    <button id="submit" type="submit">Continue to approval</button>
  </form>`;
  const script = `<script>
    const CHALLENGE = ${scriptValue(input.challenge)};
    const STATE = ${scriptValue(input.state)};
    const PLATFORM = ${scriptValue(input.platform)};
    const VERSION = ${scriptValue(input.version)};
    const REDIRECT = ${scriptValue(input.redirect)};
    document.getElementById("connect").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = document.getElementById("submit");
      const error = document.getElementById("form-error");
      const lab = form.elements.lab.value.trim().replace(/\\\/$/, "");
      const name = form.elements.name.value.trim();
      submit.disabled = true;
      submit.textContent = "Continuing…";
      error.textContent = "";
      try {
        const res = await fetch("/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lab, name }), redirect: "manual" });
        if (res.type !== "opaqueredirect" && !res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "The daemon could not continue pairing.");
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        error.textContent = message;
        error.focus();
        submit.disabled = false;
        submit.textContent = "Continue to approval";
        return;
      }
      const query = new URLSearchParams({ name, platform: PLATFORM, version: VERSION, challenge: CHALLENGE, state: STATE, redirect: REDIRECT });
      window.location.assign(lab + "/#/pair?" + query.toString());
    });
  </script>`;
  return renderPairingPage({
    title: "Pair this machine",
    tone: "neutral",
    eyebrow: "Local daemon setup",
    heading: "Pair this machine",
    description: "Name this machine and choose the Lykeion lab it should join. You will review the request in the lab before anything connects.",
    contentHtml: form + script,
    footer: "This page is served locally by the Lykeion daemon on this machine.",
  });
}

export function renderSuccessPage(input: {
  machineName: string;
  labLabel: string;
  /** Where the lab is, so this page can end by going back to it. */
  labUrl: string;
}): string {
  return renderPairingPage({
    title: "Machine ready",
    tone: "success",
    eyebrow: "Connection established",
    heading: "This machine is ready",
    // This tab is the end of a trip that started in the lab, and the last
    // thing it can usefully do is finish the round: whoever got here came
    // from a terminal and a browser tab they did not open, and telling them
    // the tab is disposable leaves them to find their way back themselves.
    description: "Pairing is complete. This machine is now part of the lab.",
    contentHtml:
      `<dl class="machine-summary"><div><dt>Machine</dt><dd>${escapeHtml(input.machineName)}</dd></div><div><dt>Lab</dt><dd>${escapeHtml(input.labLabel)}</dd></div></dl>` +
      // Named rather than "open the lab": a person with two labs open needs
      // to know which one this was, and `labLabel` is the address whenever
      // the lab has no name of its own.
      `<a class="lab-link" href="${escapeHtml(input.labUrl)}">Access ${escapeHtml(input.labLabel)}</a>`,
    footer: "The daemon will continue running in the background.",
  });
}

/**
 * The step pairing now ends on: which agents this machine has, who each is
 * signed in as, and a control that signs in the ones that are not.
 *
 * Here rather than in the lab because a sign-in is machine-scoped — it lands
 * in `~/.lykeion/agents/<id>` on this machine — and this page is the only
 * surface in the product whose subject is this machine. The browser the
 * sign-in opens then opens where the credential must land, which a lab screen
 * read from a second machine could not arrange.
 *
 * Skippable throughout. A researcher who wants one agent is not held up by
 * the other, and every agent here can also be signed in later from the dock.
 */
/** Why an agent this page shows cannot be signed in. Reads as the answer to
 *  "why is this greyed out", which is the only question a dimmed row raises. */
const NOT_INSTALLED = "not installed on this machine";

export function renderAgentSignInPage(input: {
  machineName: string;
  labLabel: string;
  labUrl: string;
  agents: ReadonlyArray<{
    agent: string;
    name: string;
    available: boolean;
    signedIn: boolean;
    account?: string;
  }>;
}): string {
  const rows = input.agents
    .map((agent) => {
      // Asked before `signedIn`, which folds "not installed" into "signed
      // out" by design (see `AgentAuth.available`). An agent whose CLI is not
      // here is shown and not offered: pressing Sign in for it used to spawn
      // an ENOENT nothing surfaced, answer 202, and leave the row saying
      // "Continue in your browser…" for as long as the tab stayed open.
      //
      // Shown rather than dropped, and disabled with the reason in its title
      // — the same grammar the dock uses for a tile it can name but not act
      // on. A machine with one CLI installed then reads as a machine with one
      // CLI installed, rather than as one where the other agent does not
      // exist.
      const status = !agent.available
        ? `<button type="button" class="agent-signin" data-agent="${escapeHtml(agent.agent)}" disabled title="${escapeHtml(agent.name)} — ${NOT_INSTALLED}">Sign in</button>`
        : agent.signedIn
          ? `<span class="agent-state agent-state--on">${escapeHtml(agent.account ?? "signed in")}</span>`
          : `<button type="button" class="agent-signin" data-agent="${escapeHtml(agent.agent)}">Sign in</button>`;
      return `<li class="agent" data-available="${agent.available}" data-signed-in="${agent.signedIn}"><span class="agent-name">${escapeHtml(agent.name)}</span>${status}</li>`;
    })
    .join("");
  // A page of rows nobody can press is worse than saying so. This is the
  // state that used to be unreachable in production — `agentAuthStates`
  // always answers with every declared agent — and it is now what a machine
  // with neither CLI installed actually gets.
  const list = input.agents.some((agent) => agent.available)
    ? `<ul class="agents">${rows}</ul>`
    : `<p class="description">No coding-agent CLI was found on this machine. Install Claude Code or Codex, then reopen this page.</p>`;
  // `:not([disabled])` in both selectors below, so a row this page rendered
  // as unpressable is neither wired to a click nor watched by the poll — the
  // poll exists to turn a row over once a sign-in this page started
  // finishes, and no sign-in was ever started for these.
  const script = `<script>
    document.querySelectorAll(".agent-signin:not([disabled])").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Continue in your browser…";
        try {
          const res = await fetch("/agents/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: button.dataset.agent }) });
          if (!res.ok) {
            // A stale page (see the poll below) cannot be fixed by pressing
            // the button again; anything else — this daemon momentarily
            // busy, a transient network hiccup — can, so only the stale
            // case is left disabled.
            button.disabled = res.status === 403;
            button.textContent = res.status === 403 ? "Could not confirm — use the link below" : "Sign in";
          }
        } catch {
          button.disabled = false;
          button.textContent = "Sign in";
        }
      });
    });
    // The sign-in finishes in another tab, so nothing here is told when it
    // does. Polling is what turns a row over — but only for an agent this
    // page itself offered a button for: pendingButtons is keyed off exactly
    // those, and a machine where one agent was already signed in before
    // this page ever loaded never puts it in this map, so there is nothing
    // watching it to read a poll's answer as new forever.
    //
    // Turned over by rewriting the row in place from the JSON a poll
    // already fetched, not by reloading the page. A reload would re-issue
    // this exact GET /paired?code=…&state=…, and the lab has already spent
    // that code — a second exchange fails outright (see finishPaired /
    // exchangeCode), on exactly the event this poll exists to detect. That
    // used to be exactly what happened here.
    const pendingButtons = new Map(
      Array.from(document.querySelectorAll(".agent-signin:not([disabled])")).map((button) => [button.dataset.agent, button]),
    );
    function turnRowOver(agent) {
      const button = pendingButtons.get(agent.agent);
      if (!button) return;
      const row = button.closest("li");
      const state = document.createElement("span");
      state.className = "agent-state agent-state--on";
      state.textContent = agent.account ?? "signed in";
      button.replaceWith(state);
      if (row) row.dataset.signedIn = "true";
      pendingButtons.delete(agent.agent);
    }
    if (pendingButtons.size > 0) {
      // A self-rescheduling timeout, not setInterval: /agents costs a real,
      // confined subprocess call per agent, slower than the two seconds
      // between ticks would allow for if the next one were already queued
      // regardless of whether this one had answered. Rescheduling only
      // once this fetch has settled is what keeps that from ever
      // overlapping itself.
      const poll = async () => {
        try {
          const res = await fetch("/agents");
          if (res.status === 403) {
            // This page's own admission has gone stale. Reloading would
            // only re-submit the code above, and there is nothing else
            // this page can do from here to confirm sign-in status — say
            // so, once, and stop asking rather than retry silently forever.
            pendingButtons.forEach((button) => {
              button.disabled = true;
              button.textContent = "Could not confirm — use the link below";
            });
            return;
          }
          if (res.ok) {
            const { agents } = await res.json();
            agents.filter((a) => pendingButtons.has(a.agent) && a.signedIn).forEach(turnRowOver);
          }
        } catch {
          // A rejected fetch — the daemon restarting, this tab's own
          // connection going with it — is caught rather than left to
          // become an unhandled rejection; there is nothing to do but ask
          // again.
        }
        if (pendingButtons.size > 0) setTimeout(poll, 2000);
      };
      setTimeout(poll, 2000);
    }
  </script>`;
  return renderPairingPage({
    title: "Sign in your agents",
    tone: "neutral",
    eyebrow: "One last step",
    heading: "Sign in your agents",
    // Not escaped here: `renderPairingPage` escapes the whole description it
    // is handed, and escaping first turned `Ana's Mac` into `Ana&#39;s Mac`
    // on the last screen of onboarding.
    description: `Lykeion runs each agent from an installation of its own on ${input.machineName}, separate from your personal one. Sign in once here and it stays signed in.`,
    contentHtml: `${list}${script}<a class="lab-link" href="${escapeHtml(input.labUrl)}">Skip — access ${escapeHtml(input.labLabel)}</a>`,
    footer: "This page is served locally by the Lykeion daemon on this machine.",
  });
}

export function renderExpiredLinkPage(): string {
  return renderPairingPage({
    title: "Link expired",
    tone: "warning",
    eyebrow: "Pairing link expired",
    heading: "This link has expired",
    description: "The pairing link is no longer current.",
    contentHtml: recovery(`Run ${command("lykeion open")} for a fresh link.`),
  });
}

export function renderNoSessionPage(): string {
  return renderPairingPage({
    title: "No pairing session",
    tone: "warning",
    eyebrow: "Pairing session unavailable",
    heading: "No pairing session is available",
    description: "This browser has not been admitted to an active pairing session.",
    contentHtml: recovery(`Run ${command("lykeion open")} for a link admitted to this browser.`),
  });
}

export function renderExpiredRequestPage(): string {
  return renderPairingPage({
    title: "Request expired",
    tone: "warning",
    eyebrow: "Pairing request expired",
    heading: "This pairing request has expired",
    description: "The lab can no longer approve this request.",
    contentHtml: recovery(`Use the fresh link printed in the daemon terminal, or run ${command("lykeion open")}.`),
  });
}

export function renderForeignCallbackPage(): string {
  return renderPairingPage({
    title: "Unexpected callback",
    tone: "error",
    eyebrow: "Pairing callback rejected",
    heading: "This callback does not match the pairing request",
    description: "No machine was connected.",
    contentHtml: recovery("Please restart the daemon and begin pairing from the link it prints."),
  });
}

export function renderRefusedPage(): string {
  return renderPairingPage({
    title: "Pairing refused",
    tone: "refusal",
    eyebrow: "Pairing was refused",
    heading: "This machine was not connected",
    description: "The pairing request was refused in the lab.",
    contentHtml: recovery("Confirm nothing connected; start the daemon again when ready to retry."),
  });
}

export function renderMissingCodePage(): string {
  return renderPairingPage({
    title: "Missing authorization code",
    tone: "error",
    eyebrow: "Authorization incomplete",
    heading: "The authorization code is missing",
    description: "The daemon could not finish pairing.",
    contentHtml: recovery("Please restart the daemon and begin again from its printed link."),
  });
}

export function renderExchangeFailurePage(
  message: string,
  sensitiveValues: readonly string[] = [],
): string {
  return renderPairingPage({
    title: "Connection failed",
    tone: "error",
    eyebrow: "Token exchange failed",
    heading: "The machine could not connect",
    description: "The lab did not complete the pairing exchange.",
    contentHtml: `<pre class="technical-detail">${escapeHtml(redactSensitiveValues(message, sensitiveValues))}</pre>${recovery("Please return to the daemon terminal before retrying.")}`,
  });
}
