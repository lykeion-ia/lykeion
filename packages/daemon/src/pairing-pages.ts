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
:root{color-scheme:dark;--canvas:#0f0f10;--surface:#151516;--surface-2:#1d1d20;--ink:#eeeff1;--muted:#aeb1b6;--subtle:#777c84;--line:#29292d;--accent:#d25e65;--success:#58be70;--warning:#d9a441;--danger:#e5705b;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{background:var(--canvas);color:var(--ink);overflow-wrap: anywhere}
body::before{content:"";position:fixed;z-index:-1;inset:-12rem -10rem auto auto;width:28rem;height:28rem;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--accent) 18%,transparent),transparent 70%)}
.page{width:min(100%,34rem);min-height:100vh;margin:auto;padding:2rem;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:.6rem;font-size:.75rem;font-weight:650;letter-spacing:.02em}.brand-mark{display:grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:.45rem;background:var(--accent);color:white}
.panel{margin:auto 0;padding:4rem 0}.status-mark{width:3.5rem;height:3.5rem;margin-bottom:1.5rem;border:1px solid var(--line);border-radius:50%;background:var(--surface);animation:arrive .35s ease-out both}.eyebrow{margin:0 0 .75rem;color:var(--subtle);font:650 .68rem/1.2 ui-monospace,"SF Mono",monospace;letter-spacing:.12em;text-transform:uppercase}h1{margin:0;color:var(--ink);font-size:clamp(2rem,8vw,3.25rem);line-height:1;letter-spacing:-.045em}.description{max-width:29rem;margin:1rem 0 0;color:var(--muted);font-size:.95rem;line-height:1.6}.page-footer{margin:2rem 0 0;color:var(--subtle);font-size:.75rem}
body[data-tone="success"] .status-mark{border-color:#25452c;background:#17271b;box-shadow:inset 0 0 0 1rem color-mix(in srgb,var(--success) 10%,transparent)}body[data-tone="warning"] .status-mark{border-color:#584825;background:#292316}body[data-tone="refusal"] .status-mark{border-color:#713c4a;background:#291b21;box-shadow:inset 0 0 0 1rem color-mix(in srgb,var(--accent) 8%,transparent)}body[data-tone="error"] .status-mark{border-color:#5a3028;background:#291a18}
.machine-summary{display:grid;gap:.5rem;margin:1.5rem 0 0;padding:.5rem;border:1px solid var(--line);border-radius:.75rem;background:var(--surface)}.machine-summary>div{display:grid;grid-template-columns:minmax(0,8rem) minmax(0,1fr);gap:1rem;padding:.5rem}.machine-summary>div+div{border-top:1px solid var(--line)}.machine-summary dt{color:var(--muted);font:650 .68rem/1.2 ui-monospace,"SF Mono",monospace;letter-spacing:.08em;text-transform:uppercase}.machine-summary dd{margin:0;color:var(--ink);overflow-wrap:anywhere}.recovery{margin:1.5rem 0 0;padding:.9rem 1rem;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:.65rem;background:var(--surface);color:var(--muted);font-size:.86rem;line-height:1.6}.recovery code{padding:.15rem .35rem;border:1px solid var(--line);border-radius:.3rem;background:var(--surface-2);color:var(--ink);font:inherit;white-space:normal;overflow-wrap:anywhere}.technical-detail{max-width:100%;margin:1.5rem 0 0;padding:1rem;border:1px solid var(--line);border-radius:.65rem;background:var(--surface);color:var(--muted);font:.78rem/1.55 ui-monospace,"SF Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}
input,button{font:inherit}input{width:100%;border:1px solid var(--line);border-radius:.55rem;background:var(--surface-2);color:var(--ink);padding:.75rem .8rem}button{border:0;border-radius:.55rem;background:var(--ink);color:var(--canvas);padding:.75rem 1rem;font-weight:650}button:disabled{cursor:wait;opacity:.55}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@keyframes arrive{from{opacity:0;transform:translateY(.4rem) scale(.96)}to{opacity:1;transform:none}}
@media (max-width: 420px){.page{padding:1.25rem}.panel{padding:2.5rem 0}h1{font-size:2.25rem}.machine-summary>div{grid-template-columns:1fr;gap:.25rem}}
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
  const footer = input.footer
    ? `<p class="page-footer">${escapeHtml(input.footer)}</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)} · Lykeion</title><style>${PAIRING_CSS}</style></head><body data-tone="${input.tone}"><main class="page"><header class="brand" aria-label="Lykeion"><span class="brand-mark" aria-hidden="true">λ</span><span>Lykeion</span></header><section class="panel"><div class="status-mark" role="status"><span aria-hidden="true"></span><span class="sr-only">${escapeHtml(input.eyebrow)}</span></div><p class="eyebrow">${escapeHtml(input.eyebrow)}</p><h1>${escapeHtml(input.heading)}</h1><p class="description">${escapeHtml(input.description)}</p>${content}${footer}</section></main></body></html>`;
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
}): string {
  return renderPairingPage({
    title: "Machine ready",
    tone: "success",
    eyebrow: "Connection established",
    heading: "This machine is ready",
    description: "Pairing is complete. It's safe to close this tab.",
    contentHtml: `<dl class="machine-summary"><div><dt>Machine</dt><dd>${escapeHtml(input.machineName)}</dd></div><div><dt>Lab</dt><dd>${escapeHtml(input.labLabel)}</dd></div></dl>`,
    footer: "The daemon will continue running in the background.",
  });
}

export function renderExpiredLinkPage(): string {
  return renderPairingPage({
    title: "Link expired",
    tone: "warning",
    eyebrow: "Pairing link expired",
    heading: "This link has expired",
    description: "The pairing link is no longer current.",
    contentHtml: recovery(`Run ${command("lykeion-daemon status")} for the current link.`),
  });
}

export function renderNoSessionPage(): string {
  return renderPairingPage({
    title: "No pairing session",
    tone: "warning",
    eyebrow: "Pairing session unavailable",
    heading: "No pairing session is available",
    description: "This browser has not been admitted to an active pairing session.",
    contentHtml: recovery(`Run ${command("lykeion-daemon status")} for a link admitted to this browser.`),
  });
}

export function renderExpiredRequestPage(): string {
  return renderPairingPage({
    title: "Request expired",
    tone: "warning",
    eyebrow: "Pairing request expired",
    heading: "This pairing request has expired",
    description: "The lab can no longer approve this request.",
    contentHtml: recovery(`Use the fresh link printed in the daemon terminal, or run ${command("lykeion-daemon status")}.`),
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
