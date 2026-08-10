import { describe, expect, it } from "vitest";
import {
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
    const html = renderRefusedPage();
    expect(html).toContain('data-tone="refusal"');
    expect(html).toContain('body[data-tone="refusal"] .status-mark');
  });

  it.each([
    ["expired link", renderExpiredLinkPage(), "lykeion-daemon status"],
    ["no session", renderNoSessionPage(), "lykeion-daemon status"],
    ["expired request", renderExpiredRequestPage(), "lykeion-daemon status"],
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
