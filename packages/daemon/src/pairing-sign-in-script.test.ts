// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderAgentSignInPage } from "./pairing-pages";

/**
 * A vanishingly small slice of the DOM this file actually touches, kept
 * local rather than reaching for the "DOM" `lib`: this package's shared
 * `tsconfig.json` has no browser in mind (`lib: ["ES2022"]`, no `"DOM"`),
 * correctly, for every other file here — `pairing.ts` itself already calls
 * bare `fetch`/`AbortController` throughout, typed against `@types/node`'s
 * own globals. Widening the shared `lib` for this one test file's sake
 * would put the DOM lib's differently-shaped `fetch`/`Response` in the same
 * type-space as those, across every file in the package, not just this
 * one. `Response` needs no such workaround — it is already a bare Node
 * global, the same one `pairing.ts` answers with.
 */
interface FakeElement {
  textContent: string | null;
  disabled: boolean;
  innerHTML: string;
  readonly dataset: Record<string, string | undefined>;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  closest(selector: string): FakeElement | null;
  click(): void;
}

interface FakeDocument {
  body: FakeElement;
  createElement(tag: string): FakeElement;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
}

function jsdomDocument(): FakeDocument {
  return (globalThis as unknown as { document: FakeDocument }).document;
}

/**
 * Extracts the page's own embedded script source, verbatim, out of a real
 * `renderAgentSignInPage` render — never a hand-copied stand-in that could
 * quietly drift from what the daemon actually ships.
 */
function extractScript(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("rendered page had no <script> to extract");
  return match[1]!;
}

/**
 * Puts the page's own markup (everything but the `<script>` tag, which
 * `runScript` below runs separately and under this test's own control)
 * into this jsdom document, fresh, for `document.querySelectorAll` inside
 * the extracted script to find. `innerHTML`, not `document.write`: a
 * `<script>` reached via `innerHTML` never executes — a deliberate,
 * unrelated part of the HTML spec — which is exactly what leaves the
 * *markup* real and the *script's own execution* fully this test's own,
 * called out separately below and never left to collide with the
 * previous test's — `document.write` reuses this file's one shared
 * window for its entire run, and a `<script>`'s own top-level `const`/
 * `function` bindings, once evaluated into that window's global scope,
 * cannot be evaluated into it a second time by a later test without
 * throwing `Identifier '…' has already been declared`. Running the
 * extracted source through `new Function` instead gives every test its
 * own, disposable function scope: no window-level bindings are ever
 * created at all, so there is nothing for a later test to collide with.
 */
function loadMarkup(html: string): void {
  jsdomDocument().body.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/, "");
}

interface ScriptGlobals {
  fetch: typeof fetch;
  /** Matches the one signature the script actually calls `setTimeout`
   *  with: a callback and a delay, nothing else. */
  setTimeout: (fn: () => void, ms: number) => number;
  reload: () => void;
  assign: (url: string) => void;
}

/**
 * Runs `html`'s own embedded script with `document`, `fetch` and
 * `setTimeout` shadowed by this call's own arguments — a plain
 * `new Function(...)` invocation, not a `<script>` element, so nothing
 * here touches any shared global scope at all. `window`/`location` are
 * shadowed too, to spy-able stand-ins, even though the current script
 * does not reference either: the point is proving a *future* regression
 * that reintroduced a `window.location.reload()`/`.assign()` call would
 * be caught by the same spies these tests already assert against, not
 * merely that today's script happens not to need them.
 */
function runScript(html: string, globals: ScriptGlobals): void {
  const body = extractScript(html);
  const win = { location: { reload: globals.reload, assign: globals.assign } };
  const fn = new Function("document", "fetch", "setTimeout", "window", "location", body);
  fn(jsdomDocument(), globals.fetch, globals.setTimeout, win, win.location);
}

/** Replaces `fetch` with a stub that answers `responses` in order,
 *  repeating the last one for any call beyond the list — an `Error` entry
 *  makes that call reject instead, exercising the poll's own `catch`. */
function stubFetch(responses: Array<Response | Error>): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

/** A `setTimeout` stand-in that never actually waits — it only records the
 *  callback, so a test can run "the next poll tick" on its own schedule,
 *  deterministically, rather than spending two real seconds per assertion
 *  on the timer the rendered script actually uses. */
function stubTimers(): {
  setTimeout: ScriptGlobals["setTimeout"];
  /** Runs the oldest still-queued callback, if any, and reports whether
   *  running it queued another behind it — a poll that keeps going
   *  schedules its own next tick from inside the one that just ran. */
  tick(): Promise<boolean>;
  pendingCount(): number;
} {
  const scheduled: Array<() => void> = [];
  return {
    setTimeout: vi.fn((fn: () => void) => {
      scheduled.push(fn);
      return 0;
    }) as unknown as ScriptGlobals["setTimeout"],
    async tick() {
      const fn = scheduled.shift();
      if (!fn) return false;
      const before = scheduled.length;
      await fn();
      return scheduled.length > before;
    },
    pendingCount: () => scheduled.length,
  };
}

/** Settles whatever microtask chain a synchronous DOM event (`.click()`)
 *  kicked off — the click handler is `async`, so its own body keeps
 *  running after the listener call itself has already returned. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const base = { machineName: "studio-mbp", labLabel: "Kellogg Lab", labUrl: "http://127.0.0.1:1421" };

/** The `ul.agents` markup a fresh server render of `agents` would have
 *  produced, parsed back out through this same jsdom, so the comparison in
 *  the "byte-equal" test below is apples to apples with whatever
 *  `document.querySelector("ul.agents").innerHTML` reads out of the live,
 *  patched page — both serialized by the same engine. */
function serverAgentsListHtml(agents: Parameters<typeof renderAgentSignInPage>[0]["agents"]): string {
  const html = renderAgentSignInPage({ ...base, agents });
  const scratch = jsdomDocument().createElement("div");
  scratch.innerHTML = html;
  const list = scratch.querySelector("ul.agents");
  if (!list) throw new Error("server render had no ul.agents to compare against");
  return list.innerHTML;
}

describe("the sign-in page's own embedded script", () => {
  it("patches a turned-over row byte-equal to the server's own rendering of the same final state", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([
      new Response(
        JSON.stringify({ agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: true, account: "r@lab.org" }] }),
        { status: 200 },
      ),
    ]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    await timers.tick();

    const patched = jsdomDocument().querySelector("ul.agents")!.innerHTML;
    const server = serverAgentsListHtml([{ agent: "claude", name: "Claude Code", available: true, signedIn: true, account: "r@lab.org" }]);
    expect(patched).toBe(server);
  });

  it("never navigates — window.location.reload and .assign are never called on the success path", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ agents: [{ agent: "claude", name: "Claude Code", signedIn: true }] }), { status: 200 }),
    ]);
    const reload = vi.fn();
    const assign = vi.fn();
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload, assign });

    await timers.tick();

    expect(reload).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("stops polling once the last pending row turns over", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ agents: [{ agent: "claude", name: "Claude Code", signedIn: true }] }), { status: 200 }),
    ]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    expect(timers.pendingCount()).toBe(1);
    const rescheduled = await timers.tick();
    expect(rescheduled).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });

  it("never starts polling when nothing is pending", () => {
    const html = renderAgentSignInPage({
      ...base,
      agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: true, account: "r@lab.org" }],
    });
    loadMarkup(html);
    const timers = stubTimers();
    runScript(html, { fetch: stubFetch([]), setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });
    expect(timers.pendingCount()).toBe(0);
  });

  it("on 403, disables the pending buttons with a message and stops polling", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([new Response(null, { status: 403 })]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    const rescheduled = await timers.tick();

    expect(rescheduled).toBe(false);
    const button = jsdomDocument().querySelector(".agent-signin")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Could not confirm — use the link below");
  });

  it("on a 500, keeps the row untouched and keeps polling", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([new Response(null, { status: 500 })]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    const rescheduled = await timers.tick();

    expect(rescheduled).toBe(true);
    const button = jsdomDocument().querySelector(".agent-signin")!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Sign in");
  });

  it("on a rejected fetch, keeps the row untouched and keeps polling", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([new Error("fetch failed")]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    const rescheduled = await timers.tick();

    expect(rescheduled).toBe(true);
    const button = jsdomDocument().querySelector(".agent-signin")!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Sign in");
  });

  it("lands an account carrying markup as text, never as new elements", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const hostile = "<img src=x onerror=alert(1)><script>document.title='pwned'</script>";
    const fetchStub = stubFetch([
      new Response(JSON.stringify({ agents: [{ agent: "claude", name: "Claude Code", signedIn: true, account: hostile }] }), {
        status: 200,
      }),
    ]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    await timers.tick();

    const document = jsdomDocument();
    expect(document.querySelectorAll("li img, li script")).toHaveLength(0);
    const state = document.querySelector(".agent-state--on")!;
    expect(state.textContent).toBe(hostile);
  });

  it("click: a 202 leaves the button disabled, waiting on the other tab", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([new Response(null, { status: 202 })]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    const button = jsdomDocument().querySelector(".agent-signin")!;
    button.click();
    await flush();

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Continue in your browser…");
  });

  it("click: a 403 disables the button with the stale message", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([new Response(null, { status: 403 })]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    const button = jsdomDocument().querySelector(".agent-signin")!;
    button.click();
    await flush();

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Could not confirm — use the link below");
  });

  it("click: any other non-ok response re-enables the button", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([new Response(null, { status: 500 })]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    const button = jsdomDocument().querySelector(".agent-signin")!;
    button.click();
    await flush();

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Sign in");
  });

  it("click: a rejected fetch also re-enables the button", async () => {
    const html = renderAgentSignInPage({ ...base, agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }] });
    loadMarkup(html);
    const timers = stubTimers();
    const fetchStub = stubFetch([new Error("fetch failed")]);
    runScript(html, { fetch: fetchStub, setTimeout: timers.setTimeout, reload: vi.fn(), assign: vi.fn() });

    const button = jsdomDocument().querySelector(".agent-signin")!;
    button.click();
    await flush();

    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Sign in");
  });
});
