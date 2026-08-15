import { describe, expect, it } from "vitest";
import {
  renderAgentSignInPage,
  renderExchangeFailurePage,
  renderExpiredLinkPage,
  renderExpiredRequestPage,
  renderForeignCallbackPage,
  renderMissingCodePage,
  renderNoSessionPage,
  renderPairingPage,
  renderRefusedPage,
  renderSetupPage,
  renderSuccessPage,
} from "./pairing-pages";

describe("pairing page shell", () => {
  it("renders one branded, semantic status document", () => {
    const html = renderPairingPage({
      title: "Machine ready",
      tone: "success",
      eyebrow: "Connection established",
      heading: "This machine is ready",
      description: "Pairing is complete.",
    });

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("Lykeion");
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain("This machine is ready");
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('role="status"');
  });

  it("escapes every caller-supplied text field", () => {
    const html = renderPairingPage({
      title: '<script id="title">',
      tone: "error",
      eyebrow: '<img src=x onerror="eyebrow">',
      heading: '<img src=x onerror="heading">',
      description: '<script id="description">',
    });

    expect(html).not.toContain('<script id="title">');
    expect(html).not.toContain('onerror="eyebrow"');
    expect(html).not.toContain('onerror="heading"');
    expect(html).not.toContain('<script id="description">');
    expect(html).toContain("&lt;script id=&quot;title&quot;&gt;");
  });

  it("contains narrow-layout and reduced-motion safeguards", () => {
    const html = renderPairingPage({
      title: "Pairing",
      tone: "neutral",
      eyebrow: "Local daemon",
      heading: "Pair this machine",
      description: "Continue in this browser.",
    });

    expect(html).toContain("@media (max-width: 420px)");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("animation: none !important");
    expect(html).toContain("focus-visible");
  });
});

describe("setup page", () => {
  const input = {
    lab: "http://127.0.0.1:1421",
    machineName: 'Ana <Mac> "M1"',
    challenge: "challenge-secret",
    state: "state-secret",
    platform: "macos-aarch64",
    version: "0.1.0",
    redirect: "http://127.0.0.1:9999/paired",
  };

  it("labels the two required fields and explains the approval handoff", () => {
    const html = renderSetupPage(input);
    expect(html).toContain("Pair this machine");
    expect(html).toContain('<label for="lab">Lykeion lab address</label>');
    expect(html).toContain('<label for="name">Machine name</label>');
    expect(html).toContain('name="lab"');
    expect(html).toContain('name="name"');
    expect(html).toContain("Continue to approval");
    expect(html).toContain('id="form-error" role="alert" aria-live="polite"');
  });

  it("escapes displayed values and serializes script values safely", () => {
    const html = renderSetupPage(input);
    expect(html).toContain('value="Ana &lt;Mac&gt; &quot;M1&quot;"');
    expect(html).not.toContain('value="Ana <Mac>');
    expect(html).toContain('const CHALLENGE = "challenge-secret"');
    expect(html).not.toContain("verifier");
    expect(html).not.toContain("a-machine-token");
  });

  it("keeps fields intact and exposes a busy state when connect fails", () => {
    const html = renderSetupPage(input);
    expect(html).toContain("submit.disabled = true");
    expect(html).toContain('submit.textContent = "Continuing…"');
    expect(html).toContain("error.textContent = message");
    expect(html).toContain("submit.disabled = false");
    expect(html).toContain('submit.textContent = "Continue to approval"');
    expect(html).not.toContain("form.reset(");
  });
});

describe("terminal pairing states", () => {
  it("ends success with machine and lab identity, and the way back to the lab", () => {
    // This tab is the end of a trip that began in the lab: a command typed
    // in a terminal opened a page nobody navigated to. Ending it by naming
    // the lab and linking to it closes the round — the alternative is
    // telling someone the tab is disposable and leaving them to find their
    // own way back to an address they may never have typed.
    const html = renderSuccessPage({
      machineName: "Ana <Mac>",
      labLabel: 'Ana & Co "Lab"',
      labUrl: "https://lab.example.edu",
    });
    expect(html).toContain("This machine is ready");
    expect(html).toContain("Ana &lt;Mac&gt;");
    expect(html).toContain("Ana &amp; Co &quot;Lab&quot;");
    expect(html).toContain('href="https://lab.example.edu"');
    // Named, not "open the lab": whoever has two labs open needs to know
    // which one this was.
    expect(html).toContain("Access Ana &amp; Co &quot;Lab&quot;");
    expect(html).not.toContain("safe to close this tab");
  });

  it("labels the way back with the address when the lab has no name of its own", () => {
    // `labLabel` already resolves that fallback, so this asserts the page
    // says whatever it was handed rather than inventing a name for a lab
    // that has none — the common case, not the odd one.
    const html = renderSuccessPage({
      machineName: "Ana",
      labLabel: "http://127.0.0.1:1421",
      labUrl: "http://127.0.0.1:1421",
    });
    expect(html).toContain("Access http://127.0.0.1:1421");
  });

  it("gives outcome details dedicated readable, narrow-safe presentation", () => {
    const html = renderSuccessPage({
      machineName: "Ana",
      labLabel: "Lab",
      labUrl: "http://127.0.0.1:1421",
    });
    expect(html).toContain(".machine-summary{");
    expect(html).toContain(".machine-summary dt{");
    expect(html).toContain(".recovery{");
    expect(html).toContain(".recovery code{");
    expect(html).toContain(".technical-detail{");
    expect(html).toContain("white-space:pre-wrap");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain(".machine-summary dt{color:var(--muted)");
  });

  it("distinguishes a deliberate refusal from warnings and failures", () => {
    // The tone used to colour a circle above the heading. The wizard has no
    // such ornament, so it colours the one thing on these pages that is
    // genuinely about the tone: the way out.
    const html = renderRefusedPage();
    expect(html).toContain('data-tone="refusal"');
    expect(html).toContain('body[data-tone="refusal"] .recovery{border-left-color:var(--accent)}');
    expect(html).toContain('body[data-tone="error"] .recovery{border-left-color:var(--danger)}');
  });

  it.each([
    ["expired link", renderExpiredLinkPage(), "lykeion open"],
    ["no session", renderNoSessionPage(), "lykeion open"],
    ["expired request", renderExpiredRequestPage(), "lykeion open"],
    ["foreign callback", renderForeignCallbackPage(), "restart the daemon"],
    ["refused", renderRefusedPage(), "start the daemon again"],
    ["missing code", renderMissingCodePage(), "restart the daemon"],
  ])("gives %s one recovery path", (_name, html, recovery) => {
    expect(html).toContain(recovery);
    expect(html.match(/class="recovery"/g)).toHaveLength(1);
  });

  it("escapes and redacts a lab exchange failure before rendering one retry path", () => {
    const nonce = "nonce-7c932";
    const verifier = "verifier-e4791";
    const code = "code-b6af4";
    const state = "state-20df0";
    const html = renderExchangeFailurePage(
      `<img src=x onerror="steal()"> ${nonce} ${verifier} ${code} ${state}`,
      [nonce, verifier, code, state],
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="steal()"');
    expect(html).toContain("&lt;img src=x onerror=&quot;steal()&quot;&gt;");
    expect(html).not.toContain(nonce);
    expect(html).not.toContain(verifier);
    expect(html).not.toContain(code);
    expect(html).not.toContain(state);
    expect(html.match(/\[redacted\]/g)).toHaveLength(4);
    expect(html).toContain("return to the daemon terminal");
    expect(html.match(/class="recovery"/g)).toHaveLength(1);
  });
});

describe("agent sign-in page", () => {
  const base = { machineName: "studio-mbp", labLabel: "Kellogg Lab", labUrl: "http://127.0.0.1:1421" };

  it("offers a sign-in for each agent that has none", () => {
    const html = renderAgentSignInPage({
      ...base,
      agents: [
        { agent: "claude", name: "Claude Code", available: true, signedIn: false },
        { agent: "codex", name: "Codex", available: true, signedIn: true, account: "r@lab.org" },
      ],
    });
    expect(html).toContain("Claude Code");
    expect(html).toContain('data-agent="claude"');
    // The one already signed in says who it is, and offers nothing to press.
    expect(html).toContain("r@lab.org");
    expect(html).not.toContain('data-agent="codex"');
  });

  it("shows an agent this machine does not have, and refuses to offer a sign-in for it", () => {
    // The defect this closes: `agentAuthStates` reports an uninstalled CLI as
    // signed out, so a machine with only Claude showed a live Sign in button
    // for Codex. Pressing it spawned an ENOENT nothing surfaced, the route had
    // already answered 202, and the row read "Continue in your browser…" for
    // as long as the tab stayed open.
    //
    // Shown and not dropped, in the dock's own grammar for a thing it can
    // name but not act on: disabled, dimmed, the reason in the title. A
    // machine with one CLI then reads as a machine with one CLI, rather than
    // as one where the other agent does not exist at all.
    const html = renderAgentSignInPage({
      ...base,
      agents: [
        { agent: "claude", name: "Claude Code", available: true, signedIn: false },
        { agent: "codex", name: "Codex", available: false, signedIn: false },
      ],
    });
    expect(html).toContain("Codex");
    expect(html).toContain('data-available="false"');
    expect(html).toContain('title="Codex — not installed on this machine"');
    // Disabled at the source: the button is unpressable, and the script's own
    // selectors exclude it, so nothing wires it to a click and no poll ever
    // starts watching a row that can never turn over.
    expect(html).toMatch(/data-agent="codex"[^>]*disabled/);
    expect(html).toContain('.agent-signin:not([disabled])');
    // The one that IS installed is still offered, unchanged.
    expect(html).toMatch(/data-agent="claude"(?![^>]*disabled)/);
  });

  it("says so plainly when this machine has no coding-agent CLI at all", () => {
    // Reachable at last. `agentAuthStates` always answers with every declared
    // agent, so before `available` existed this state could only be produced
    // by a caller that handed the page an empty list — which production never
    // does. A page of rows nobody can press is worse than saying so once.
    const html = renderAgentSignInPage({
      ...base,
      agents: [
        { agent: "claude", name: "Claude Code", available: false, signedIn: false },
        { agent: "codex", name: "Codex", available: false, signedIn: false },
      ],
    });
    expect(html).toContain("No coding-agent CLI was found on this machine");
    expect(html).not.toContain('class="agents"');
    // And the way past it is still there: a researcher is never stuck here.
    expect(html).toContain(base.labUrl);
  });

  it("lets a researcher move on without signing anything in", () => {
    // Somebody who wants only Claude must not be held up by Codex.
    const html = renderAgentSignInPage({ ...base, agents: [] });
    expect(html).toContain(base.labUrl);
  });

  it("names the machine the way the researcher named it, escaped exactly once", () => {
    // `renderPairingPage` escapes the description it is handed, so escaping
    // it here as well showed `Ana's Mac` as `Ana&#39;s Mac` on the last
    // screen of onboarding — a hostname with an apostrophe in it being the
    // ordinary macOS default, not an odd case.
    const html = renderAgentSignInPage({ ...base, machineName: "Ana's <Mac>", agents: [] });
    expect(html).toContain("Ana&#39;s &lt;Mac&gt;");
    expect(html).not.toContain("Ana&amp;#39;s");
  });

  it("escapes an account the researcher did not choose the shape of", () => {
    const html = renderAgentSignInPage({
      ...base,
      agents: [
        { agent: "claude", name: "Claude Code", available: true, signedIn: true, account: "<script>x</script>" },
      ],
    });
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("the wizard's frame", () => {
  // These pages and the setup wizard are the same first run seen either side
  // of a redirect. They were two visual registers: a 34rem full-height column
  // with a status circle and an uppercase mono eyebrow over a display-size
  // heading, against the wizard's 560px column with a modest heading and a
  // footer strip. A researcher crossing between them saw two products.

  it("derives its palette from the same five seeds the application does", () => {
    // Not matched by hand. The greys were picked independently and had already
    // drifted — the muted step was #aeb1b6 here against a computed #c6c7c9
    // there — and two hand-tuned palettes drift again the moment either moves.
    const html = renderNoSessionPage();
    expect(html).toContain("--seed-bg:#0f0f10");
    expect(html).toContain("--seed-ink:#eeeff1");
    expect(html).toContain("--seed-surface:#151516");
    expect(html).toContain("--seed-accent:#d25e65");
    expect(html).toContain("color-mix(in srgb,var(--seed-ink) 82%,var(--seed-bg))");
  });

  it("holds its content in the column width the wizard holds its own in", () => {
    expect(renderNoSessionPage()).toContain("max-width:560px");
  });

  it("sets its heading at the wizard's size rather than at display size", () => {
    const html = renderNoSessionPage();
    expect(html).toContain("font-size:2rem");
    expect(html).toContain("letter-spacing:-.03em");
    // The old clamp went to 3.25rem, which is what made these pages read as a
    // different product from two rooms away.
    expect(html).not.toContain("clamp(2rem,8vw,3.25rem)");
  });

  it("keeps the status for a screen reader after taking the circle away", () => {
    // The eyebrow said what kind of page this is — "PAIRING SESSION
    // UNAVAILABLE" — and the wizard has nothing like it. Dropping it from the
    // page would drop that from assistive technology too, so it stays as the
    // live region and loses only its visual weight.
    const html = renderNoSessionPage();
    expect(html).toContain('role="status"');
    expect(html).toContain("Pairing session unavailable");
    expect(html).not.toContain('class="status-mark"');
  });

  it("gives a footer strip only to a page that has something to put in it", () => {
    // The strip is the wizard's, and on a step it carries the dots. A refusal
    // is where the flow stopped: a progress strip there would draw movement
    // that is not happening, and an empty bordered rule would be furniture.
    expect(
      renderSetupPage({
        lab: "http://127.0.0.1:1421",
        machineName: "ana-macbook",
        challenge: "c",
        state: "s",
        platform: "macos-aarch64",
        version: "0.1.0",
        redirect: "http://127.0.0.1:9999/paired",
      }),
    ).toContain('class="strip"');
    expect(renderNoSessionPage()).not.toContain('class="strip"');
  });
});
