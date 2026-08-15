import { afterEach, expect, it, vi } from "vitest";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { decodeRequest } from "@lykeion/api/pair-code";
import { acceptedAdapters, consentKey } from "./adapter-consent";
import { DAEMON_VERSION } from "./config";
import { platformTag } from "./probe";
import { pasteInstructions, PairingRefused, startPairing, type PairingSession } from "./pairing";
import { forwardTo } from "./front-door";
import { CATALOGUE } from "./probe";
import { isolationFor } from "./agent-registry";
import { readState, type PairedState } from "./state";
import { labIsHere } from "./lab-child";
import type { AgentAuth } from "./agent-auth";

let clock = 1_700_000_000;

const dirs: string[] = [];
const sessions: PairingSession[] = [];
const labs: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  clock = 1_700_000_000;
  for (const session of sessions.splice(0)) await session.close();
  for (const lab of labs.splice(0)) await lab.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-pairing-"));
  dirs.push(dir);
  return dir;
}

/** A built application for the front door to serve. Injected rather than
 *  taken from `packages/ui/dist`, so that what this server answers at a path
 *  it has no route for is decided here and not by whether the machine running
 *  the suite happens to have built the UI — with nothing there the door
 *  answers its own 404, which is the same status as the refusal these tests
 *  are about and would pass them for the wrong reason. */
function builtUi(): string {
  const dir = freshDir();
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Lykeion</title>");
  return dir;
}

/** A GET whose request target arrives exactly as it was written. `fetch`
 *  collapses dot segments before it sends anything, so the spellings that
 *  matter most — the ones no ordinary client can even produce — would reach
 *  the server as something else and the test would be proving nothing. */
function rawGet(
  base: string,
  target: string,
  cookie: string,
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: hostname, port, path: target, headers: { cookie } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A PATH holding a runnable stand-in for each named command, so whether
 *  `/agents/signin` starts anything is decided by a fixture rather than by
 *  what the machine running this suite happens to have installed. */
function pathHolding(...commands: string[]): string {
  const dir = freshDir();
  for (const command of commands) {
    const file = join(dir, command);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `predicate` holds, or gives up loudly. For the one thing
 *  here that happens on a real timer rather than on a request: a request
 *  running out of time with nobody asking it anything. */
async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} never held`);
}

async function pairing(
  options: {
    lab?: string;
    ttlSeconds?: number;
    onRequestExpired?: (link: string) => void;
    // `"real"` opts back into `startPairing`'s own default — leaving
    // `authStates` out of the call to it entirely — rather than one more
    // stub function, so the actual production code path
    // (`agentAuthStates({ dataDir, signal })` in `pairing.ts`) is reachable
    // from this file at all. Plain `options.authStates ?? stub` could never
    // produce that: any function a caller supplies, stub or real, still
    // reaches `startPairing` as a defined `authStates`, and `startPairing`'s
    // own `??` only ever falls through when the option is left out.
    authStates?: (() => Promise<AgentAuth[]>) | "real";
    signInSpawn?: typeof spawn;
    signInPath?: string;
    /** Opens the session the way a daemon that was already paired when it
     *  started opens one: serving the sign-in step and nothing else. */
    alreadyPaired?: PairedState;
    /** The built application the front door serves. Left out by every test
     *  that is not about the front door, which then gets the real one. */
    uiDir?: string;
    /** Where the lab's own routes go, when a lab is running on this
     *  computer. Left out by everything but the two tests about that. */
    forward?: (req: IncomingMessage, res: ServerResponse) => void;
    /** Brings a lab up because the first run said it lives here. Left out by
     *  everything but the two tests about that. */
    onLabHere?: () => Promise<void>;
  } = {},
): Promise<PairingSession> {
  const session = await startPairing({
    port: 0,
    dataDir: freshDir(),
    lab: options.lab,
    ttlSeconds: options.ttlSeconds,
    onRequestExpired: options.onRequestExpired,
    now: () => clock,
    alreadyPaired: options.alreadyPaired,
    uiDir: options.uiDir,
    // `/paired` asks this too now, by default against whatever this
    // machine's real PATH resolves `claude`/`codex` to, the same real,
    // confined subprocess call `agent-auth.test.ts` exercises on its own.
    // Every test in this file is asserting on the pairing protocol itself —
    // state, nonce, expiry — not on agent auth, and some race a request's
    // own clock closely enough that spending a real multi-hundred-
    // millisecond call inside `/paired` throws that race off. Stubbed empty
    // by default; nothing here asserts on the agents `/paired` reports.
    authStates: options.authStates === "real" ? undefined : (options.authStates ?? (async () => [])),
    signInSpawn: options.signInSpawn,
    signInPath: options.signInPath,
    forward: options.forward,
    onLabHere: options.onLabHere,
  });
  sessions.push(session);
  // A test that never touches `paired` (most of them only care about one
  // HTTP response) would otherwise leave a rejection unconsumed the moment
  // any of them exercises a failing exchange — a real path, not a test-only
  // one, since a bad code rejects this the same way in production.
  session.paired.catch(() => {});
  return session;
}

/** Admits the one tab a fresh session allows, and hands back the cookie a
 *  real browser would have stored, for every request after admission. */
async function admit(session: PairingSession): Promise<string> {
  const res = await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("admission did not set a cookie");
  return cookie.split(";")[0]!;
}

/**
 * A stub lab that answers `/daemon/pair/exchange` on its own loopback
 * server, so the daemon's half of that call — that it sends back the
 * verifier it kept, and stores what comes home — can be exercised without
 * the real lab server.
 */
async function stubLab(options: {
  expectVerifier: (verifier: string) => boolean;
  /** Holds the response back — long enough for a test to destroy the
   *  daemon's connection to its own browser while this is still pending,
   *  the same window a real network round trip to a lab opens up. */
  delayMs?: number;
  /** What the lab calls itself. A lab that has never been named answers the
   *  empty string here, which is what the workspace server does today for
   *  every lab there is. */
  labName?: string;
}): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const respond = () => {
        const body = raw ? (JSON.parse(raw) as { code?: string; verifier?: string }) : {};
        if (!body.verifier || !options.expectVerifier(body.verifier)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "that verifier does not match" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            token: "a-machine-token",
            runtimeId: "rt_1",
            machineName: "ana-macbook",
            labName: options.labName ?? "Ana's Lab",
          }),
        );
      };
      if (options.delayMs) setTimeout(respond, options.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const handle = { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  labs.push(handle);
  return handle;
}

async function closedLoopbackBase(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function labServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const handle = {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  labs.push(handle);
  return handle;
}

it("admits one tab on the nonce and refuses the second", async () => {
  const session = await pairing();
  const first = await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  expect(first.status).toBe(200);
  const second = await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  expect(second.status).toBe(403);
});

it("ends a connection that is mid-request rather than waiting it out", async () => {
  // The connection a browser leaves behind is what kept this server open
  // once, and no wall clock can tell a browser that has finished loading
  // from one about to hang up. A request begun and never finished is the
  // same fact without the guesswork: the server is holding something it
  // considers in flight, which nothing resolves on its own, and closing
  // has to end it rather than wait it out.
  const session = await pairing();
  const socket = connect(session.port, "127.0.0.1");
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const outcome = await Promise.race([
    session.close().then(() => "closed" as const),
    new Promise<"still holding on">((resolve) => setTimeout(() => resolve("still holding on"), 2000)),
  ]);
  socket.destroy();
  expect(outcome).toBe("closed");
});

it("retires the link it last handed out when it mints another", async () => {
  const session = await pairing();
  const retired = `${session.base}/?nonce=${session.nonce}`;
  const fresh = session.rotateNonce();
  expect(fresh).not.toBe(retired);
  expect((await fetch(retired, { redirect: "manual" })).status).toBe(403);
  expect((await fetch(fresh, { redirect: "manual" })).status).toBe(200);
});

it("admits again on a fresh link after the last one was used", async () => {
  // The plainest way this is ever reached: somebody opens the link, loses
  // the tab, and asks for another. The nonce that link carried is spent, and
  // a fresh one that inherited that has not opened anything for anybody.
  const session = await pairing();
  await admit(session);
  expect((await fetch(session.rotateNonce(), { redirect: "manual" })).status).toBe(200);
});

it("mints a link that is good from when it was minted, not from when the daemon started", async () => {
  const session = await pairing();
  // Long past the life of the link this session started with, which is the
  // state a daemon left running all afternoon is in when somebody finally
  // asks it how it is doing.
  clock += 10_000;
  expect((await fetch(session.rotateNonce(), { redirect: "manual" })).status).toBe(200);
});

it("shuts out the tab admitted on a link that has since been retired", async () => {
  const session = await pairing();
  const cookie = await admit(session);
  expect((await fetch(`${session.base}/`, { headers: { cookie } })).status).toBe(200);
  session.rotateNonce();
  expect((await fetch(`${session.base}/`, { headers: { cookie } })).status).toBe(403);
});

it("still finishes a pairing already away at the lab when a link is retired", async () => {
  // What a retired link takes away is admission to this daemon's own page.
  // A browser that has already been sent on to the lab's approval screen
  // comes back to a callback that knows its own request by the state it
  // minted, and finishing that is not something a fresh link should undo.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({ lab: lab.base });
  verifier = session.verifier;
  await admit(session);
  session.rotateNonce();
  const res = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);
  expect(res.status).toBe(200);
  expect(readState(session.dataDir)!.token).toBe("a-machine-token");
});

it("ends the pairing when the lab's screen says the member refused it", async () => {
  const session = await pairing();
  const res = await fetch(`${session.base}/paired?state=${session.state}&refused=1`);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("This machine was not connected");
  expect(body).toContain("Confirm nothing connected; start the daemon again when ready to retry.");
  await expect(session.paired).rejects.toThrow(PairingRefused);
});

it("does not end the pairing on a refusal that cannot prove it is this machine's", async () => {
  // A refusal carries no code, so the state is the whole of what stands
  // between the lab's own screen and anything else that can reach loopback.
  // Anybody on this machine could otherwise stop a colleague's pairing.
  const session = await pairing();
  const res = await fetch(`${session.base}/paired?state=not-the-one&refused=1`);
  expect(res.status).toBe(400);
  const settled = await Promise.race([
    session.paired.then(() => "settled" as const, () => "settled" as const),
    new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 250)),
  ]);
  expect(settled).toBe("still waiting");
});

it("opens another request when the one it is holding runs out of time", async () => {
  // A real timer on a short lease rather than a driven clock: the point of
  // this is that nobody has to ask — the daemon notices on its own, with no
  // request arriving to prompt it.
  const expired: string[] = [];
  // Leave enough of the replacement request's lease for this assertion to
  // reach the loopback server even while the monorepo test gate is busy.
  // With a 50 ms lease, the replacement could legitimately expire before
  // fetch was scheduled, making this a scheduler test instead of a pairing
  // test.
  const session = await pairing({ ttlSeconds: 0.5, onRequestExpired: (link) => expired.push(link) });
  const abandoned = { challenge: session.challenge, state: session.state, link: `${session.base}/?nonce=${session.nonce}` };

  await waitFor(() => expired.length === 1);

  expect(session.challenge).not.toBe(abandoned.challenge);
  expect(session.state).not.toBe(abandoned.state);
  // The link it announced is the one that now works, and the abandoned one
  // does not — a fresh request whose old link still opened the page would
  // leave two doors where the guard is meant to be one.
  expect((await fetch(expired[0]!, { redirect: "manual" })).status).toBe(200);
  expect((await fetch(abandoned.link, { redirect: "manual" })).status).toBe(403);
});

it("keeps the port it was reached on when a request is replaced", async () => {
  // The tunnelled recipe forwards one fixed port and the lab will only
  // redirect to loopback, so a replacement that rebound would strand a
  // researcher pairing a machine over SSH mid-flow.
  const announced: string[] = [];
  const session = await pairing({ ttlSeconds: 0.05, onRequestExpired: (link) => announced.push(link) });
  await waitFor(() => announced.length > 0, "a request to expire");
  expect(new URL(announced[0]!).port).toBe(String(session.port));
});

it("tells a browser its approval was for a request that has since expired", async () => {
  const session = await pairing();
  const wasApproving = session.state;
  session.rotateRequest();

  const res = await fetch(`${session.base}/paired?code=abc&state=${wasApproving}`);
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("This pairing request has expired");
  expect(body).toContain("Use the fresh link printed in the daemon terminal");
  expect(body).toContain("lykeion open");
  // The other answer is for a callback that was never this machine's, and
  // telling the two apart is the whole reason the previous state is kept.
  expect(body).not.toContain("This callback does not match the pairing request");
});

it("does not mistake an unrelated callback for an expired one", async () => {
  const session = await pairing();
  session.rotateRequest();
  const body = await (await fetch(`${session.base}/paired?code=abc&state=never-minted-here`)).text();
  expect(body).toContain("This callback does not match the pairing request");
  expect(body).toContain("Please restart the daemon and begin pairing from the link it prints.");
  expect(body).not.toContain("This pairing request has expired");
});

it("gives the researcher a full span again when they leave for the lab", async () => {
  // Reaching the lab, signing in to it and reading the approval screen all
  // happen where this daemon cannot see, so the handoff restarts the clock
  // rather than spending what filling in the form already cost. Timed
  // against the real one: the span this pushes is a real timer, and a test
  // driving the injected clock instead would pass whether it pushed or not.
  const announced: string[] = [];
  const lab = await stubLab({ expectVerifier: () => true });
  const session = await pairing({
    ttlSeconds: 0.4,
    onRequestExpired: (link) => announced.push(link),
  });
  const cookie = await admit(session);
  const asked = session.state;
  await sleep(300);

  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: lab.base, name: "ana-macbook" }),
    redirect: "manual",
  });
  expect(res.status).toBe(200);

  // Past where the original span ran out, well inside the one the handoff
  // bought. A request that had not been pushed is already gone by here.
  await sleep(300);
  expect(announced).toEqual([]);
  expect(session.state).toBe(asked);
});

it("refuses a request carrying neither nonce nor cookie", async () => {
  const session = await pairing();
  const res = await fetch(`${session.base}/`);
  expect(res.status).toBe(403);
  const body = await res.text();
  expect(body).toContain("No pairing session is available");
  expect(body).toContain("lykeion open");
});

it("refuses a nonce older than three minutes", async () => {
  const session = await pairing();
  clock += 181;
  const res = await fetch(`${session.base}/?nonce=${session.nonce}`);
  expect(res.status).toBe(403);
  const body = await res.text();
  expect(body).toContain("This link has expired");
  expect(body).toContain("lykeion open");
});

it("serves the setup page to a tab admitted by cookie, without a nonce", async () => {
  // An empty `uiDir`, so this exercises the daemon's OWN page: `/` serves the
  // application wherever one is built, and what is asserted below is the
  // fallback a daemon running from source falls back to.
  const session = await pairing({ uiDir: freshDir() });
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Lykeion lab address");
  expect(body).toContain("Machine name");
  expect(body).toContain("Continue to approval");
  expect(body).toContain('role="alert"');
});

it("serves the setup page again when the admitted tab reloads the link it arrived on", async () => {
  // A reload sends the address bar back unchanged, spent nonce and all,
  // which is the ordinary way this page is asked for a second time. The
  // cookie the daemon itself handed that tab is what says it is the same
  // tab, and it has to be worth something on a URL that still carries the
  // nonce — otherwise reloading the page is indistinguishable from a second
  // browser trying the link.
  const session = await pairing();
  const cookie = await admit(session);
  const reloaded = await fetch(`${session.base}/?nonce=${session.nonce}`, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(reloaded.status).toBe(200);
});

it("still refuses the spent link to a browser that has no cookie", async () => {
  // The other half of the reload rule: admission by cookie must not turn
  // the nonce into something a second browser can follow.
  const session = await pairing();
  await admit(session);
  const second = await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  expect(second.status).toBe(403);
});

it("sends the browser to the lab with everything the approval screen needs", async () => {
  const lab = await stubLab({ expectVerifier: () => true });
  const session = await pairing();
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      cookie,
      origin: session.base,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ lab: lab.base, name: "ana-macbook" }),
    redirect: "manual",
  });
  expect(res.status).toBe(200);
  const target = new URL(((await res.clone().json()) as { redirect?: string }).redirect!);
  const params = new URLSearchParams(target.hash.slice(target.hash.indexOf("?")));
  expect(target.origin).toBe(lab.base);
  expect(params.get("name")).toBe("ana-macbook");
  expect(params.get("challenge")).toBe(session.challenge);
  expect(params.get("state")).toBe(session.state);
  expect(params.get("redirect")).toBe(`${session.base}/paired`);
});

it("returns JSON 400 when the lab connection is refused", async () => {
  const session = await pairing();
  const cookie = await admit(session);
  const unreachable = await closedLoopbackBase();
  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: unreachable, name: "ana-macbook" }),
    redirect: "manual",
  });

  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(await res.json()).toEqual({
    error: `could not reach ${unreachable}`,
  });
});

it("rejects a non-HTTP lab without retaining it", async () => {
  // An empty `uiDir`, so this exercises the daemon's OWN page: `/` serves the
  // application wherever one is built, and what is asserted below is the
  // fallback a daemon running from source falls back to.
  const session = await pairing({ uiDir: freshDir() });
  const cookie = await admit(session);
  const asked = session.state;
  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: "data:text/plain,not-a-lab", name: "ana-macbook" }),
    redirect: "manual",
  });

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "the lab address must use http or https" });
  expect(session.state).toBe(asked);
  const setup = await (await fetch(`${session.base}/`, { headers: { cookie } })).text();
  expect(setup).toContain('name="lab" type="url" value=""');
});

it("probes the lab with a material-free HEAD and does not follow redirects", async () => {
  let observed:
    | {
        method: string | undefined;
        url: string | undefined;
        headers: IncomingMessage["headers"];
        body: string;
      }
    | undefined;
  const lab = await labServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      observed = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(302, { location: "http://127.0.0.1:1/should-not-be-followed" });
      res.end();
    });
  });
  const session = await pairing();
  const cookie = await admit(session);

  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: lab.base, name: "ana-macbook" }),
    redirect: "manual",
  });

  expect(res.status).toBe(200);
  expect(observed).toMatchObject({ method: "HEAD", url: "/", body: "" });
  expect(JSON.stringify(observed)).not.toMatch(/ana-macbook|challenge|state|redirect|verifier|code/i);
});

it("rejects cross-origin and safelisted connect attempts before probing or extending the request", async () => {
  let probes = 0;
  const lab = await labServer((_req, res) => {
    probes += 1;
    res.writeHead(204);
    res.end();
  });
  const announced: string[] = [];
  const session = await pairing({
    ttlSeconds: 0.7,
    onRequestExpired: (link) => announced.push(link),
  // An empty `uiDir`, so this exercises the daemon's OWN page: `/` serves the
  // application wherever one is built, and what is asserted below is the
  // fallback a daemon running from source falls back to.
    uiDir: freshDir(),
  });
  const cookie = await admit(session);
  const asked = session.state;
  await sleep(450);
  const body = JSON.stringify({ lab: lab.base, name: "poisoned-machine" });

  const safelisted = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "text/plain;foo=application/json", cookie },
    body,
    redirect: "manual",
  });
  const crossOrigin = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:65535",
    },
    body,
    redirect: "manual",
  });
  const crossSite = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "sec-fetch-site": "cross-site",
    },
    body,
    redirect: "manual",
  });

  expect(safelisted.status).toBe(415);
  expect(crossOrigin.status).toBe(403);
  expect(crossSite.status).toBe(403);
  expect(probes).toBe(0);
  expect(session.state).toBe(asked);
  const setup = await (await fetch(`${session.base}/`, { headers: { cookie } })).text();
  expect(setup).toContain('name="lab" type="url" value=""');
  await sleep(350);
  expect(announced).toHaveLength(1);
  expect(session.state).not.toBe(asked);
});

it("commits the first completed connect and conflicts an overlapping slower one", async () => {
  let releaseSlowHead!: () => void;
  let slowHeadArrived!: () => void;
  const sawSlowHead = new Promise<void>((resolve) => (slowHeadArrived = resolve));
  let slowExchanges = 0;
  const slow = await labServer((req, res) => {
    if (req.method === "HEAD") {
      slowHeadArrived();
      releaseSlowHead = () => {
        res.writeHead(204);
        res.end();
      };
      return;
    }
    slowExchanges += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        token: "slow-token",
        runtimeId: "rt_slow",
        machineName: "slow-machine",
        labName: "Slow Lab",
      }),
    );
  });
  let fastExchanges = 0;
  const fast = await labServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(204);
      res.end();
      return;
    }
    fastExchanges += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        token: "fast-token",
        runtimeId: "rt_fast",
        machineName: "fast-machine",
        labName: "Fast Lab",
      }),
    );
  });
  const announced: string[] = [];
  const session = await pairing({
    lab: slow.base,
    ttlSeconds: 0.7,
    onRequestExpired: (link) => announced.push(link),
  });
  const cookie = await admit(session);
  const slowConnect = fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: slow.base, name: "slow-machine" }),
    redirect: "manual",
  });
  await sawSlowHead;

  const fastConnect = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: fast.base, name: "fast-machine" }),
    redirect: "manual",
  });
  expect(fastConnect.status).toBe(200);
  const wonRedirect = ((await fastConnect.clone().json()) as { redirect: string }).redirect;
  expect(new URL(wonRedirect).origin).toBe(fast.base);

  await sleep(450);
  releaseSlowHead();
  const lateSlow = await slowConnect;
  expect(lateSlow.status).toBe(409);
  // The loser gets a refusal, and above all no address to leave for.
  expect(((await lateSlow.clone().json()) as { redirect?: string }).redirect).toBeUndefined();
  expect(await lateSlow.json()).toEqual({
    error: "this pairing request is already continuing to a lab",
  });

  const callback = await fetch(`${session.base}/paired?code=approved&state=${session.state}`);
  expect(callback.status).toBe(200);
  expect(readState(session.dataDir)).toMatchObject({ lab: fast.base, token: "fast-token" });
  expect(fastExchanges).toBe(1);
  expect(slowExchanges).toBe(0);
  await sleep(350);
  // The fast connect's own touchDeadline armed this session's expiry timer
  // for 700ms from its own commit, well inside the ~800ms this test's own
  // sleeps add up to by here — so an unfixed expiry timer, indifferent to
  // whether this exact request went on to pair, fires once in this window
  // regardless. `/paired` succeeding, above, clears that same timer now
  // (see `finishPaired`): a session that has paired has no request left to
  // expire, so nothing fires here at all.
  expect(announced).toHaveLength(0);
});

it("does not refresh the request deadline when lab reachability fails", async () => {
  const announced: string[] = [];
  const session = await pairing({
    ttlSeconds: 0.5,
    onRequestExpired: (link) => announced.push(link),
  });
  const cookie = await admit(session);
  const asked = session.state;
  await sleep(350);
  const unreachable = await closedLoopbackBase();

  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: unreachable, name: "ana-macbook" }),
    redirect: "manual",
  });
  expect(res.status).toBe(400);
  await sleep(250);

  expect(announced).toHaveLength(1);
  expect(session.state).not.toBe(asked);
});

it("rejects a preflight that finishes after the request rotated", async () => {
  let headArrived!: () => void;
  const sawHead = new Promise<void>((resolve) => (headArrived = resolve));
  let releaseHead!: () => void;
  let requestExpired!: () => void;
  const expired = new Promise<void>((resolve) => (requestExpired = resolve));
  let exchangeCalls = 0;
  const lab = await labServer((req, res) => {
    if (req.method === "HEAD") {
      headArrived();
      releaseHead = () => {
        res.writeHead(204);
        res.end();
      };
      return;
    }
    exchangeCalls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "should not exchange" }));
  });
  const session = await pairing({
    ttlSeconds: 0.3,
    onRequestExpired: () => requestExpired(),
  });
  const cookie = await admit(session);
  const asked = session.state;
  const connecting = fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: lab.base, name: "ana-macbook" }),
    redirect: "manual",
  });
  await sawHead;
  await expired;
  releaseHead();

  const res = await connecting;
  expect(session.state).not.toBe(asked);
  expect(res.status).toBe(403);
  expect(((await res.clone().json()) as { redirect?: string }).redirect).toBeUndefined();
  expect(await res.json()).toEqual({ error: "run lykeion open for a fresh link" });

  const callback = await fetch(`${session.base}/paired?code=must-not-exchange&state=${session.state}`);
  expect(callback.status).toBe(400);
  expect(await callback.text()).toContain("The authorization code is missing");
  expect(exchangeCalls).toBe(0);
});

it("aborts a silent lab preflight when the pairing session closes", async () => {
  const sockets = new Set<Socket>();
  let headArrived!: () => void;
  const sawHead = new Promise<void>((resolve) => (headArrived = resolve));
  const server = createServer((req) => {
    if (req.method === "HEAD") headArrived();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const session = await pairing();
  const cookie = await admit(session);
  const connecting = fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: `http://127.0.0.1:${port}`, name: "ana-macbook" }),
  }).catch(() => undefined);
  await sawHead;

  const started = Date.now();
  await session.close();
  await connecting;
  const closed = new Promise<"closed">((resolve) => server.close(() => resolve("closed")));
  const outcome = await Promise.race([
    closed,
    sleep(750).then(() => "still open" as const),
  ]);

  if (outcome !== "closed") {
    for (const socket of sockets) socket.destroy();
    await closed;
  }
  expect(outcome).toBe("closed");
  expect(Date.now() - started).toBeLessThan(750);
});

it("refuses to connect without the admission cookie", async () => {
  const session = await pairing();
  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lab: "https://lab.uni.edu", name: "ana-macbook" }),
  });
  expect(res.status).toBe(403);
});

it("recognises only its own state on the callback", async () => {
  // A lab is named so a session with no `/connect` call yet has one reason
  // fewer to refuse a callback — without it, the state check being skipped
  // would still land on "no lab was named" and answer 400 anyway, passing
  // this test for the wrong reason. The address is never meant to be
  // reached: a callback that recognises its own state stops before this.
  const session = await pairing({ lab: "http://127.0.0.1:1" });
  const res = await fetch(`${session.base}/paired?code=abc&state=somebody-elses`);
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("This callback does not match the pairing request");
  expect(body).toContain("Please restart the daemon and begin pairing from the link it prints.");
});

it("renders the missing-code recovery page for a valid callback without a code", async () => {
  const session = await pairing({ lab: "http://127.0.0.1:1" });
  const res = await fetch(`${session.base}/paired?state=${session.state}`);
  expect(res.status).toBe(400);
  const body = await res.text();
  expect(body).toContain("The authorization code is missing");
  expect(body).toContain("Please restart the daemon and begin again from its printed link.");
});

it("exchanges the code and writes the token", async () => {
  // The stub has to exist before the session does, to hand its address in
  // as `lab` — but the session is what mints the verifier the stub is meant
  // to check. A variable closed over by the predicate, set once the session
  // exists and read only once the callback actually fires, breaks that
  // ordering cycle without needing either side built with knowledge it
  // cannot have yet.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({ lab: lab.base });
  verifier = session.verifier;
  const res = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);
  expect(res.status).toBe(200);
  expect(readState(session.dataDir)!.token).toBe("a-machine-token");
});

it("says on the page which lab the machine now belongs to, and links back to it", async () => {
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier, labName: "Ana's Lab" });
  // Against a daemon with no built application, which is the one arrangement
  // where this page is still what `/paired` answers with. With an application
  // to serve, pairing comes back onto the wizard's own agents step instead —
  // and what that page says is asserted where that page is built.
  const session = await pairing({ lab: lab.base, uiDir: join(freshDir(), "nothing-built-here") });
  verifier = session.verifier;
  const res = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("Lykeion");
  // Pairing no longer ends on a dead end — it ends on the step that signs
  // this machine's agents in.
  expect(body).toContain("Sign in your agents");
  expect(body).toContain("ana-macbook");
  expect(body).toContain("Ana&#39;s Lab");
  // The name the lab gave for itself, pointing at the address this machine
  // actually reached it on — the round trip that started in a browser tab
  // and went through a terminal ends back where it began, for whoever skips
  // signing anything in here.
  expect(body).toContain("Skip — access Ana&#39;s Lab");
  expect(body).toContain(`href="${lab.base}"`);
});

it("names the lab by its address on that page when the lab has no name of its own", async () => {
  // Which is every lab the workspace server serves: it has a column for the
  // organization's name, nothing ever writes to it, and the exchange answers
  // with the empty string it holds. A page that interpolates that tells a
  // researcher their machine belongs to nobody, on the last screen the
  // pairing flow ever shows them.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier, labName: "" });
  // No built application, so this page is what `/paired` answers with — see
  // the test above for why that is now the one arrangement it appears in.
  const session = await pairing({ lab: lab.base, uiDir: join(freshDir(), "nothing-built-here") });
  verifier = session.verifier;
  const res = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);
  const body = await res.text();
  expect(body).toContain("ana-macbook");
  expect(body).toContain(lab.base);
});

it(
  "stops running its own request clock once it has paired, however long it stays open",
  async () => {
    // The regression this guards: /connect arms a timer (touchDeadline) that
    // nothing had ever cleared once a session outlives a successful pairing.
    // Before Task 8, closing the session the instant `paired` resolved
    // cleared this same timer as a side effect of `close()`; now that a
    // paired session is kept open on purpose — the sign-in page `/paired`
    // renders goes on polling and posting to it — nothing did, and the
    // timer fired every `ttlSeconds` on a machine that already had a token,
    // announcing a bogus expiry and minting a fresh, WORKING pairing link
    // each time. Forever.
    let verifier = "";
    const lab = await stubLab({ expectVerifier: (v) => v === verifier });
    const announced: string[] = [];
    const session = await pairing({
      lab: lab.base,
      ttlSeconds: 0.2,
      onRequestExpired: (link) => announced.push(link),
    });
    verifier = session.verifier;
    const res = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);
    expect(res.status).toBe(200);
    // Several multiples of the ttl a re-armed timer would have refired on —
    // an unfixed regression announces at least three or four links in this
    // window, not a near miss either way.
    await sleep(900);
    expect(announced).toHaveLength(0);
  },
  5000,
);

/** What a daemon that was already paired when it started reads off disk. */
const ALREADY_PAIRED: PairedState = {
  lab: "http://127.0.0.1:1421",
  token: "t",
  runtimeId: "r_1",
  machineName: "ana-macbook",
  labName: "Kellogg Lab",
};

it("serves the sign-in step again to a daemon that was already paired", async () => {
  // D-5: the step is skippable, "and reachable again later by re-opening the
  // daemon's local address". Before this, the loopback server was created
  // only inside `if (!machine)`, so a researcher who skipped signing in had
  // no way back short of deleting this machine's pairing and starting over —
  // while the dock went on telling them to open a page that did not exist.
  const session = await pairing({
    alreadyPaired: ALREADY_PAIRED,
    authStates: async () => [
      { agent: "claude", name: "Claude Code", available: true, signedIn: false },
    ],
  // An empty `uiDir`, so this exercises the daemon's OWN page: `/` serves the
  // application wherever one is built, and what is asserted below is the
  // fallback a daemon running from source falls back to.
    uiDir: freshDir(),
  });
  const admitted = await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  expect(admitted.status).toBe(200);
  const html = await admitted.text();
  expect(html).toContain("Sign in your agents");
  expect(html).toContain('data-agent="claude"');
  // Not the form that names a lab: this machine already has one.
  expect(html).not.toContain('id="connect"');
});

it("refuses the sign-in page to a browser this session never admitted", async () => {
  const session = await pairing({ alreadyPaired: ALREADY_PAIRED });
  expect((await fetch(`${session.base}/`, { redirect: "manual" })).status).toBe(403);
  // And a spent link stays spent — one link, one browser, however long this
  // daemon has been running.
  await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  expect(
    (await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" })).status,
  ).toBe(403);
});

it("routes neither /connect nor /paired for a daemon that is already paired", async () => {
  // The whole of what a paired daemon may offer is the sign-in step. Naming
  // a different lab, or spending a second code, are things this link must not
  // be able to ask for — so those two routes do not exist on it at all,
  // rather than existing and refusing.
  const session = await pairing({ alreadyPaired: ALREADY_PAIRED });
  const cookie = await admit(session);
  const connect = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: session.base },
    body: JSON.stringify({ lab: "http://127.0.0.1:1", name: "somewhere-else" }),
    redirect: "manual",
  });
  expect(connect.status).toBe(404);
  const paired = await fetch(`${session.base}/paired?code=abc&state=${session.state}`, {
    headers: { cookie },
  });
  expect(paired.status).toBe(404);
  // Nothing was re-homed by either attempt.
  expect(readState(session.dataDir)).toBeUndefined();
});

it("refuses a route it does not have in every spelling of it, rather than serving the application", async () => {
  // The front door stands in front of this refusal and answers everything
  // else with the application, so `/paired` on a paired daemon is the one
  // place the two decisions meet. Asserted on the body as well as the status,
  // because the door's own "the application has not been built" is a 404 too:
  // a status alone passes on any machine where the UI is simply missing,
  // which is every clean checkout, and would have said nothing at all.
  const session = await pairing({ alreadyPaired: ALREADY_PAIRED, uiDir: builtUi() });
  const cookie = await admit(session);
  const query = `code=abc&state=${session.state}`;
  // Every way of writing the one route. `%70` is `p` (RFC 3986 §6.2.2.2) and
  // `/paired/` names what `/paired` names — neither of which the URL parser
  // touches. The dot segments and the protocol-relative form are the other
  // half: the parser collapses all four to `/paired` before the route table
  // ever sees them, so a guard that read the request target instead would let
  // them past on their way to a route that must not exist here.
  for (const spelling of [
    "/paired",
    "/%70aired",
    "/paired/",
    "/x/../paired",
    "/./paired",
    "/%2e%2e/paired",
    "//somewhere-else/paired",
  ]) {
    const refused = await rawGet(session.base, `${spelling}?${query}`, cookie);
    expect(refused.status, spelling).toBe(404);
    expect(JSON.parse(refused.body), spelling).toEqual({ error: "no such route" });
  }
  expect(readState(session.dataDir)).toBeUndefined();
});

it("answers a path it has no route for with the application, so a deep link opens", async () => {
  // The other half of the same decision, and the reason the one above cannot
  // be read as "this server answers 404 to everything". No cookie: what the
  // front door widened is what is served, never what is decided — `/` is
  // still behind the nonce gate, and nothing here touches it.
  const session = await pairing({ uiDir: builtUi() });
  const deep = await fetch(`${session.base}/start`);
  expect(deep.status).toBe(200);
  expect(deep.headers.get("content-type")).toContain("text/html");
  expect(await deep.text()).toContain("<title>Lykeion</title>");
});

it("still gates the sign-in routes of an already-paired daemon on admission and origin", async () => {
  const session = await pairing({
    alreadyPaired: ALREADY_PAIRED,
    authStates: async () => [],
  });
  expect((await fetch(`${session.base}/agents`)).status).toBe(403);
  const cookie = await admit(session);
  expect((await fetch(`${session.base}/agents`, { headers: { cookie } })).status).toBe(200);
  expect(
    (await fetch(`${session.base}/agents`, { headers: { cookie, origin: "http://evil.example" } }))
      .status,
  ).toBe(403);
  const signin = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { cookie, "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ agent: "claude" }),
  });
  expect(signin.status).toBe(403);
});

it("never mints a live pairing link on its own clock, however often it is asked for a fresh one", async () => {
  // `status` now rotates the nonce for a paired daemon too, and rotation is
  // what used to re-arm the request timer whose callback mints a fresh,
  // WORKING pairing link and announces it. On a machine that already has a
  // token that must never happen — not once, and not on the hundredth ask.
  const announced: string[] = [];
  const session = await pairing({
    alreadyPaired: ALREADY_PAIRED,
    ttlSeconds: 0.05,
    onRequestExpired: (link) => announced.push(link),
  });
  for (let i = 0; i < 5; i += 1) session.rotateNonce();
  await sleep(500);
  expect(announced).toHaveLength(0);
});

it("keeps minting nothing on its own clock after pairing during its own run", async () => {
  // The same guarantee for the other way a session ends up paired. The test
  // above this one covers a session that never had a request; this covers one
  // that had a real request, spent it, and is then asked for fresh links by
  // `status` for as long as the daemon runs.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const announced: string[] = [];
  const session = await pairing({
    lab: lab.base,
    ttlSeconds: 0.2,
    onRequestExpired: (link) => announced.push(link),
  // An empty `uiDir`, so this exercises the daemon's OWN page: `/` serves the
  // application wherever one is built, and what is asserted below is the
  // fallback a daemon running from source falls back to.
    uiDir: freshDir(),
  });
  verifier = session.verifier;
  expect((await fetch(`${session.base}/paired?code=abc&state=${session.state}`)).status).toBe(200);
  for (let i = 0; i < 5; i += 1) session.rotateNonce();
  await sleep(900);
  expect(announced).toHaveLength(0);
  // And what that fresh link now opens is the sign-in step, not the form.
  const admitted = await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  expect(await admitted.text()).toContain("Sign in your agents");
}, 5000);

it("lets a link minted after this session paired actually use the page it opens", async () => {
  // The gap the two cases above cannot see. A session that pairs during its
  // own run freezes `pairedCookie`, and `signInAuthorized` used to accept
  // only that — so the fresh link `open` mints for a paired daemon
  // admitted a browser at `/`, served it the sign-in page, and then refused
  // that page's own first `/agents` poll and every `/agents/signin` it could
  // send. Bricked before its own script ran a single request, which is the
  // exact failure `pairedCookie` was introduced to prevent, arriving from the
  // other side. A restarted daemon never sees it: `pairedCookie` is undefined
  // there.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({
    lab: lab.base,
    authStates: async () => [
      { agent: "claude", name: "Claude Code", available: true, signedIn: false },
    ],
    signInSpawn: (() => ({ on: () => {}, unref: () => {} })) as unknown as typeof spawn,
    signInPath: pathHolding("claude"),
    // An empty `uiDir`, so this exercises the daemon's OWN page: `/` serves
    // the application wherever one is built, and what this asserts on is the
    // fallback a daemon running from source falls back to.
    uiDir: freshDir(),
  });
  verifier = session.verifier;
  // The tab that carried pairing through, and the cookie it still holds.
  const paired = await admit(session);
  expect(
    (await fetch(`${session.base}/paired?code=abc&state=${session.state}`, { headers: { cookie: paired } }))
      .status,
  ).toBe(200);

  // Months later: `lykeion open` mints a fresh admission link, and a
  // second browser opens it.
  const link = session.rotateNonce();
  const opened = await fetch(link, { redirect: "manual" });
  expect(opened.status).toBe(200);
  expect(await opened.text()).toContain("Sign in your agents");
  const reopened = opened.headers.get("set-cookie")!.split(";")[0]!;
  expect(reopened).not.toBe(paired);

  // The page that browser was just handed can do the two things it exists to
  // do, rather than 403ing on both.
  expect((await fetch(`${session.base}/agents`, { headers: { cookie: reopened } })).status).toBe(200);
  const signin = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: reopened },
    body: JSON.stringify({ agent: "claude" }),
  });
  expect(signin.status).toBe(202);

  // And the tab that carried pairing through still works, which is the whole
  // reason `pairedCookie` exists.
  expect((await fetch(`${session.base}/agents`, { headers: { cookie: paired } })).status).toBe(200);
  // A cookie this session never issued is still refused by both.
  expect(
    (await fetch(`${session.base}/agents`, { headers: { cookie: "lykeion_pair=invented" } })).status,
  ).toBe(403);
});

it("refuses /agents to a request that was never admitted", async () => {
  const session = await pairing();
  const res = await fetch(`${session.base}/agents`);
  expect(res.status).toBe(403);
});

it("answers /agents with what authStates reports, once admitted", async () => {
  const agents: AgentAuth[] = [
    { agent: "claude", name: "Claude Code", available: true, signedIn: false },
    { agent: "codex", name: "Codex", available: true, signedIn: true, account: "r@lab.org" },
  ];
  const session = await pairing({ authStates: async () => agents });
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/agents`, { headers: { cookie } });
  expect(res.status).toBe(200);
  // Matched rather than equalled: this route also carries each agent's
  // adapter on this machine, and whether one resolves depends on what is
  // installed where the suite happens to be running. What is asserted is that
  // every field `authStates` reported survives the trip unchanged — the
  // augmentation adds, and must never overwrite.
  const body = (await res.json()) as { agents: Record<string, unknown>[] };
  // The whole catalogue is listed; what this asserts is that every field
  // `authStates` reported about the two it CAN ask about survives the trip
  // unchanged. The roster adds rows, and must never overwrite an answer.
  for (const expected of agents)
    expect(body.agents.find((row) => row.agent === expected.agent)).toMatchObject(
      expected as unknown as Record<string, unknown>,
    );
});

it("answers /agents with the real, uninjected agentAuthStates when nothing overrides it", async () => {
  // The one test in this file that reaches pairing.ts's actual production
  // default (agentAuthStates({ dataDir, signal })) rather than a stub —
  // every other test opts out of it for the timing reason explained on
  // `pairing()`'s own `authStates` option above.
  const session = await pairing({ authStates: "real" });
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/agents`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { agents: Record<string, unknown>[] };
  expect(Array.isArray(body.agents)).toBe(true);
  for (const agent of body.agents) {
    expect(agent).toMatchObject({
      agent: expect.any(String),
      // Carried over the wire, not only computed: the page's own poll reads
      // this answer, and a row it cannot tell "not installed" from "signed
      // out" for is a row it offers a dead button on.
      available: expect.any(Boolean),
    });
  }
  // And the sign-in answer is there for exactly the agents that have a
  // confined home to be asked from, and absent for the rest. Both halves,
  // because this route now lists the whole catalogue: a boolean on a row
  // nothing asked would be a claim, and a missing one on a row that WAS
  // asked would cost that row its Sign in control.
  const declared = new Set(
    CATALOGUE.filter((entry) => isolationFor(entry.id) !== undefined).map((entry) => entry.id),
  );
  expect(declared.size).toBeGreaterThan(0);
  for (const agent of body.agents)
    expect(typeof agent.signedIn === "boolean").toBe(declared.has(agent.agent as string));
  // The budget every other test in this repo that spawns real confined
  // subprocesses carries. This one reaches the production default, which asks
  // two agent CLIs about themselves inside the sandbox, and it had been
  // running on vitest's 5s default — thin for that before this route also
  // walked the catalogue, and the first thing to go on a busy machine.
}, 30_000);

it("refuses /agents/signin to a request that was never admitted", async () => {
  const session = await pairing();
  const res = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "claude" }),
  });
  expect(res.status).toBe(403);
});

it("starts a sign-in once admitted, without ever spawning a real login flow", async () => {
  // Injected the same way agent-auth.test.ts itself keeps startSignIn from
  // touching a real CLI: this only proves the route reaches startSignIn
  // and reports what it says, never that a real browser opens.
  const spawnFn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
  const session = await pairing({
    signInSpawn: spawnFn as unknown as typeof spawn,
    signInPath: pathHolding("claude"),
  });
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ agent: "claude" }),
  });
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ started: true });
  expect(spawnFn).toHaveBeenCalled();
});

it("refuses to sign in a declared agent whose CLI this machine does not have", async () => {
  // The page will not offer a button for it, but the route is what actually
  // has to hold: nothing spawned, and a reason a caller can read, rather than
  // a 202 followed by silence.
  const spawnFn = vi.fn();
  const session = await pairing({
    signInSpawn: spawnFn as unknown as typeof spawn,
    signInPath: pathHolding("claude"),
  });
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ agent: "codex" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()) as { reason?: string }).toMatchObject({
    started: false,
    reason: expect.stringContaining("not installed on this machine"),
  });
  expect(spawnFn).not.toHaveBeenCalled();
});

it("refuses to sign in an agent nobody has declared, once admitted", async () => {
  const session = await pairing();
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ agent: "not-a-real-agent" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { started: boolean; reason?: string };
  expect(body.started).toBe(false);
  expect(body.reason).toBeTruthy();
});

it("keeps /agents and /agents/signin working for the tab that paired, even if its nonce rotated first", async () => {
  // The exact scenario the review reproduced live: `rotateNonce` (what
  // `status` calls) can fire in the window between a tab being admitted
  // and the lab's callback reaching `/paired` — `rotateNonce`'s own
  // comment already says a tab that has gone on to the lab's approval
  // screen still finishes regardless, and it does: `/paired` proves
  // itself by `state`, not by cookie. What broke was everything the
  // sign-in page that response renders does next: /agents and
  // /agents/signin both checked the admitted tab's cookie against the
  // now-rotated nonce instead of the one it actually carries, so the very
  // page the daemon just served came up permanently 403'd.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({ lab: lab.base });
  const cookie = await admit(session);
  verifier = session.verifier;
  session.rotateNonce();
  // Carries the cookie explicitly: a real browser resends it automatically
  // on this exact top-level navigation (`SameSite=Lax` allows a cookie set
  // on this origin to survive a top-level GET arriving back at it, even
  // after a cross-origin hop through the lab in between) — `fetch` here has
  // no cookie jar of its own, so this is standing in for that.
  const paired = await fetch(`${session.base}/paired?code=abc&state=${session.state}`, {
    headers: { cookie },
  });
  expect(paired.status).toBe(200);
  const agentsRes = await fetch(`${session.base}/agents`, { headers: { cookie } });
  expect(agentsRes.status).toBe(200);
  const signinRes = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ agent: "not-a-real-agent" }),
  });
  // 400, not 403: admitted fine, refused only for naming an undeclared
  // agent — proves the cookie was accepted, not merely that the route
  // answered at all.
  expect(signinRes.status).toBe(400);
});

it("does not freeze an unvalidated, request-supplied cookie into the accepted secret", async () => {
  // Cookies are not port-scoped: on loopback, any other origin on this
  // same host can set `lykeion_pair` to a value of its own choosing.
  // Driving `/paired` with such a value must not make it *become* this
  // session's accepted secret going forward — that would hand an
  // attacker-chosen cookie the same standing the genuinely admitted one
  // has, while the real cookie is locked out.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({ lab: lab.base });
  verifier = session.verifier;
  const forged = "attacker-chosen-value";
  const paired = await fetch(`${session.base}/paired?code=abc&state=${session.state}`, {
    headers: { cookie: `lykeion_pair=${forged}` },
  });
  expect(paired.status).toBe(200);
  const res = await fetch(`${session.base}/agents`, { headers: { cookie: `lykeion_pair=${forged}` } });
  expect(res.status).toBe(403);
});

it("rejects cross-origin and cross-site calls to /agents and /agents/signin even with a valid cookie", async () => {
  const session = await pairing();
  const cookie = await admit(session);

  const crossOriginAgents = await fetch(`${session.base}/agents`, {
    headers: { cookie, origin: "http://127.0.0.1:65535" },
  });
  expect(crossOriginAgents.status).toBe(403);

  const crossSiteAgents = await fetch(`${session.base}/agents`, {
    headers: { cookie, "sec-fetch-site": "cross-site" },
  });
  expect(crossSiteAgents.status).toBe(403);

  const crossOriginSignin = await fetch(`${session.base}/agents/signin`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:65535" },
    body: JSON.stringify({ agent: "claude" }),
  });
  expect(crossOriginSignin.status).toBe(403);
});

it("refuses /connect once this session has paired", async () => {
  // The previous Critical's exact shape: reachable when a machine pairs
  // with `--lab` already given, so no `/connect` ever committed a
  // `state`. Without this, a post-pair `/connect` would still re-arm the
  // expiry timer `/paired` just stopped and redirect to whatever lab a
  // caller names — reopening Critical 1 in full.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({ lab: lab.base });
  const cookie = await admit(session);
  verifier = session.verifier;
  const paired = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);
  expect(paired.status).toBe(200);
  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: "http://127.0.0.1:1", name: "attacker-named" }),
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "this machine has already paired" });
});

it("renders a safe recovery page when the lab exchange fails", async () => {
  const session = await pairing({ lab: "http://127.0.0.1:1" });
  const code = "abc";
  const state = session.state;
  const res = await fetch(`${session.base}/paired?code=${code}&state=${state}`);
  const body = await res.text();
  expect(res.status).toBe(502);
  expect(body).toContain("The machine could not connect");
  expect(body).toContain("return to the daemon terminal");
  expect(body).not.toContain(session.nonce);
  expect(body).not.toContain(session.verifier);
  expect(body).not.toContain(code);
  expect(body).not.toContain(state);
});

it("refuses a nonce of the same length that is not the one it minted", async () => {
  // The comparison itself rather than the length check in front of it: a
  // constant-time comparison that was reached only by strings of unequal
  // length would be doing nothing at all.
  const session = await pairing();
  const forged = `${session.nonce.slice(0, -1)}${session.nonce.endsWith("a") ? "b" : "a"}`;
  expect(forged).toHaveLength(session.nonce.length);
  expect(forged).not.toBe(session.nonce);
  expect((await fetch(`${session.base}/?nonce=${forged}`)).status).toBe(403);
});

it("refuses a callback carrying a state of the same length that it never minted", async () => {
  const session = await pairing({ lab: "http://127.0.0.1:1" });
  const forged = `${session.state.slice(0, -1)}${session.state.endsWith("a") ? "b" : "a"}`;
  expect(forged).toHaveLength(session.state.length);
  const res = await fetch(`${session.base}/paired?code=abc&state=${forged}`);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("This callback does not match the pairing request");
});

it("refuses a cookie of the same length as the one it handed out", async () => {
  const session = await pairing();
  const cookie = await admit(session);
  const value = cookie.slice(cookie.indexOf("=") + 1);
  const forged = `${value.slice(0, -1)}${value.endsWith("a") ? "b" : "a"}`;
  expect(forged).toHaveLength(value.length);
  expect((await fetch(`${session.base}/`, { headers: { cookie: `lykeion_pair=${forged}` } })).status).toBe(403);
});

it("takes back an exchange the lab never answers when it closes", async () => {
  // A lab that accepts the connection and then says nothing. Nothing about
  // closing servers reaches a call already out at one, so a session that
  // did not take this back would hold the daemon for the runtime's own
  // request timeout — minutes, on a stop a person is watching.
  const sockets: Socket[] = [];
  const silent = createServer(() => {});
  silent.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const session = await pairing({ lab: `http://127.0.0.1:${port}` });
  const callback = fetch(`${session.base}/paired?code=abc&state=${session.state}`).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  await session.close();
  const took = Date.now() - started;

  await callback;
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
  expect(took).toBeLessThan(2000);
});

it("settles even when the browser's connection is destroyed before the response is written", async () => {
  // The lab is made to sit on its answer, opening the same window a slow
  // real network round trip would: long enough to destroy the daemon's
  // connection to its own browser while `/paired` is still awaiting it,
  // before this response has been written at all.
  const lab = await stubLab({ expectVerifier: () => true, delayMs: 150 });
  const session = await pairing({ lab: lab.base });

  const socket = connect(session.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.write(
        `GET /paired?code=abc&state=${session.state} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`,
      );
      resolve();
    });
    socket.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.destroy();

  const settled = await Promise.race([
    session.paired.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 2500)),
  ]);
  expect(settled).not.toBe("timed-out");

  const closeStart = Date.now();
  await session.close();
  expect(Date.now() - closeStart).toBeLessThan(2000);
});

it("hands the lab's own routes to the lab when one is running on this computer", async () => {
  const asked: string[] = [];
  const session = await pairing({
    forward: (req, res) => {
      asked.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("the lab answered");
    },
  });

  const answer = await fetch(`${session.base}/rpc`, { method: "POST", body: "{}" });

  expect(answer.status).toBe(200);
  expect(await answer.text()).toBe("the lab answered");
  expect(asked).toEqual(["POST /rpc"]);
});

it("goes on refusing the lab's routes when the lab is somewhere else", async () => {
  const session = await pairing();

  const answer = await fetch(`${session.base}/rpc`, { method: "POST", body: "{}" });

  expect(answer.status).toBe(404);
});

it("keeps its own routes when a lab is running behind it", async () => {
  let forwarded = false;
  const session = await pairing({
    forward: (_req, res) => {
      forwarded = true;
      res.end("the lab answered");
    },
  });

  // Nonceless, so it is refused by the route rather than answered by it —
  // the point is which of the two decided, and admission is not what this
  // test is about.
  const answer = await fetch(`${session.base}/`, { redirect: "manual" });

  expect(forwarded).toBe(false);
  expect(answer.status).not.toBe(404);
});

/** Posts the first run's branching answer the way its own page does. Takes
 *  the cookie rather than admitting itself: a session admits one tab, and a
 *  helper that admitted on every call would spend a nonce per question. */
function chooseTopology(
  session: PairingSession,
  cookie: string,
  topology: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${session.base}/setup/topology`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...extra },
    body: JSON.stringify({ topology }),
  });
}

it("writes the researcher's answer where the next start of this daemon will read it", async () => {
  // The lab being here is a fact about this computer, not about the tab that
  // answered — so it has to outlive the page, and a reload must not be able
  // to un-decide it.
  const session = await pairing({ authStates: async () => [] });
  const cookie = await admit(session);
  expect(labIsHere(session.dataDir)).toBe(false);

  const answer = await chooseTopology(session, cookie, "here");

  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ topology: "here" });
  expect(labIsHere(session.dataDir)).toBe(true);
});

it("takes somewhere else back, rather than only declining to say here", async () => {
  // The absence of the record is what "the lab is not here" means, so this
  // answer has to REMOVE it. A researcher who chose wrongly and came back
  // would otherwise be told their answer was taken while the daemon went on
  // starting a lab they had just said they did not want.
  const session = await pairing({ authStates: async () => [] });
  const cookie = await admit(session);
  await chooseTopology(session, cookie, "here");
  expect(labIsHere(session.dataDir)).toBe(true);

  const answer = await chooseTopology(session, cookie, "elsewhere");

  expect(answer.status).toBe(200);
  expect(labIsHere(session.dataDir)).toBe(false);
});

it("refuses an answer nobody recognises rather than guessing which was meant", async () => {
  const session = await pairing({ authStates: async () => [] });
  const cookie = await admit(session);
  for (const topology of ["HERE", "local", "", undefined, 1, null]) {
    const answer = await chooseTopology(session, cookie, topology);
    expect(answer.status, JSON.stringify(topology)).toBe(400);
  }
  expect(labIsHere(session.dataDir)).toBe(false);
});

it("refuses to be told where the lab lives by a request that was never admitted", async () => {
  // No content-type gate means this is a CORS-simple request: without the
  // admission check, any page open in this browser could decide where a
  // researcher's lab lives.
  const session = await pairing({ authStates: async () => [] });
  const answer = await fetch(`${session.base}/setup/topology`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topology: "here" }),
  });
  expect(answer.status).toBe(403);
  expect(labIsHere(session.dataDir)).toBe(false);
});

it("refuses that route to a page from any other origin", async () => {
  const session = await pairing({ authStates: async () => [] });
  const cookie = await admit(session);
  const answer = await chooseTopology(session, cookie, "here", { "sec-fetch-site": "cross-site" });
  expect(answer.status).toBe(403);
  expect(labIsHere(session.dataDir)).toBe(false);
});

it("never answers the topology route with the application", async () => {
  // It is a route this server owns, so a GET has to be refused rather than
  // fall through to the page — the same rule that keeps the SPA fallback
  // from swallowing a forwarded prefix.
  const session = await pairing({ authStates: async () => [] });
  const cookie = await admit(session);
  const answer = await fetch(`${session.base}/setup/topology`, { headers: { cookie } });
  expect(answer.status).toBe(404);
  expect(answer.headers.get("content-type") ?? "").not.toContain("text/html");
});

/** A session whose lab is standing behind this daemon, which is what the
 *  co-located routes require: the forwarding handler IS that fact. */
async function coLocated(labBase: string): Promise<PairingSession> {
  return pairing({ lab: labBase, forward: () => {}, authStates: async () => [] });
}

it("hands its own page the secrets the redirect would have carried", async () => {
  const lab = await stubLab({ expectVerifier: () => true });
  const session = await coLocated(lab.base);
  const cookie = await admit(session);

  const answer = await fetch(`${session.base}/setup/challenge`, { headers: { cookie } });

  expect(answer.status).toBe(200);
  const body = (await answer.json()) as Record<string, string>;
  expect(body.challenge).toBe(session.challenge);
  expect(body.state).toBe(session.state);
  expect(body.redirect).toBe(`${session.base}/paired`);
  // Prefilled rather than asked for: the machine's own name is a thing this
  // computer knows about itself, and typing it again is ceremony.
  expect(body.name).toBeTruthy();
});

it("completes the same exchange the redirect does, without one", async () => {
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await coLocated(lab.base);
  verifier = session.verifier;
  const cookie = await admit(session);

  const answer = await fetch(`${session.base}/setup/paired`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: "abc", state: session.state }),
  });

  expect(answer.status).toBe(200);
  expect(readState(session.dataDir)!.token).toBe("a-machine-token");
  // Settled the same way the redirect settles it: the session's own promise
  // resolves, so whatever is waiting on this daemon being paired goes on.
  await expect(session.paired).resolves.toMatchObject({ token: "a-machine-token" });
});

it("never takes this path for a lab that is not on this machine", async () => {
  // The whole argument for skipping the approval screen is that the person
  // approving and the person asking are demonstrably the same, which holds
  // only while the lab is behind this daemon's own address.
  const session = await pairing({ lab: "https://lab.example.edu", authStates: async () => [] });
  const cookie = await admit(session);

  expect((await fetch(`${session.base}/setup/challenge`, { headers: { cookie } })).status).toBe(409);
  const posted = await fetch(`${session.base}/setup/paired`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: "abc", state: session.state }),
  });
  expect(posted.status).toBe(409);
  expect(readState(session.dataDir)).toBeUndefined();
});

it("refuses an answer minted for a different pairing request", async () => {
  const lab = await stubLab({ expectVerifier: () => true });
  const session = await coLocated(lab.base);
  const cookie = await admit(session);

  const answer = await fetch(`${session.base}/setup/paired`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: "abc", state: "not-the-state-this-session-minted" }),
  });

  expect(answer.status).toBe(400);
  expect(readState(session.dataDir)).toBeUndefined();
});

it("refuses both co-located routes to a page that was never admitted, and to any other origin", async () => {
  const lab = await stubLab({ expectVerifier: () => true });
  const session = await coLocated(lab.base);
  const cookie = await admit(session);

  expect((await fetch(`${session.base}/setup/challenge`)).status).toBe(403);
  expect(
    (
      await fetch(`${session.base}/setup/challenge`, {
        headers: { cookie, "sec-fetch-site": "cross-site" },
      })
    ).status,
  ).toBe(403);

  const unadmitted = await fetch(`${session.base}/setup/paired`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "abc", state: session.state }),
  });
  expect(unadmitted.status).toBe(403);
  expect(readState(session.dataDir)).toBeUndefined();
});

it("never answers either co-located route with the application", async () => {
  const lab = await stubLab({ expectVerifier: () => true });
  const session = await coLocated(lab.base);
  const cookie = await admit(session);
  // A GET on the exchange route, and a route the server owns either way.
  const answer = await fetch(`${session.base}/setup/paired`, { headers: { cookie } });
  expect(answer.status).toBe(404);
  expect(answer.headers.get("content-type") ?? "").not.toContain("text/html");
});

it("starts the lab when the first run says it lives here, so the next step has one", async () => {
  // The step after the question creates the owner account IN this lab,
  // through this daemon's own address. Waiting for the next start of the
  // daemon would meet the researcher with a screen that has nothing behind
  // it — so answering the question is what brings the lab up.
  const lab = await stubLab({ expectVerifier: () => true });
  const labPort = Number(new URL(lab.base).port);
  let started = 0;
  const session = await pairing({
    authStates: async () => [],
    onLabHere: async () => {
      started += 1;
      session.serveLabThrough(labPort);
    },
  });
  const cookie = await admit(session);

  // Before the answer there is no lab behind this daemon, and the co-located
  // routes say so rather than pretending.
  expect((await fetch(`${session.base}/setup/challenge`, { headers: { cookie } })).status).toBe(409);

  const answer = await chooseTopology(session, cookie, "here");
  expect(answer.status).toBe(200);
  expect(started).toBe(1);
  expect(labIsHere(session.dataDir)).toBe(true);
  expect((await fetch(`${session.base}/setup/challenge`, { headers: { cookie } })).status).toBe(200);
});

it("takes the record back when the lab it just recorded will not start", async () => {
  // Keeping it would leave this machine saying its lab is here on the
  // strength of an attempt that failed, while the researcher was told it did
  // not work.
  const session = await pairing({
    authStates: async () => [],
    onLabHere: async () => {
      throw new Error("no port to be had");
    },
  });
  const cookie = await admit(session);

  const answer = await chooseTopology(session, cookie, "here");

  expect(answer.status).toBe(500);
  expect(((await answer.json()) as { error: string }).error).toContain("no port to be had");
  expect(labIsHere(session.dataDir)).toBe(false);
  expect((await fetch(`${session.base}/setup/challenge`, { headers: { cookie } })).status).toBe(409);
});

it("comes back onto the agents step rather than a seam", async () => {
  // The trip out to the lab and back happened INSIDE step 2, so the count
  // promised at step 1 still holds: a researcher returning from approving
  // their machine lands on the step that was waiting, not on a page from a
  // different product.
  const ui = freshDir();
  writeFileSync(join(ui, "index.html"), '<!doctype html><html lang="en"><body></body></html>');
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({ lab: lab.base, uiDir: ui, authStates: async () => [] });
  verifier = session.verifier;
  await admit(session);

  const answer = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);

  expect(answer.status).toBe(200);
  expect(answer.headers.get("content-type") ?? "").toContain("text/html");
  expect(await answer.text()).toContain('data-setup-step="3"');
});

it("still answers with its own page when there is no application to serve", async () => {
  // A daemon running from source with no built UI has just completed a real
  // pairing. Saying so on a page it renders itself beats a 404 for a page it
  // has not got.
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier });
  const session = await pairing({
    lab: lab.base,
    uiDir: join(freshDir(), "nothing-built-here"),
    authStates: async () => [],
  });
  verifier = session.verifier;
  await admit(session);

  const answer = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);

  expect(answer.status).toBe(200);
  const body = await answer.text();
  expect(body).not.toContain("data-setup-step");
  expect(body).toContain("Lykeion");
});

it("tells its own page what this machine is called, whatever the topology", async () => {
  // The join branch needs a machine name to offer, and its lab is explicitly
  // somewhere else — so this cannot be the route that refuses when the lab is
  // not here.
  const session = await pairing({ lab: "https://lab.example.edu", authStates: async () => [] });
  const cookie = await admit(session);

  const answer = await fetch(`${session.base}/setup/machine`, { headers: { cookie } });

  expect(answer.status).toBe(200);
  const body = (await answer.json()) as Record<string, string>;
  expect(body.name).toBeTruthy();
  expect(body.platform).toBeTruthy();
  expect(body.daemonVersion).toBeTruthy();
  // And the co-located route still refuses, on the same session.
  expect((await fetch(`${session.base}/setup/challenge`, { headers: { cookie } })).status).toBe(409);
});

it("refuses the machine route to a request that was never admitted", async () => {
  const session = await pairing({ authStates: async () => [] });
  expect((await fetch(`${session.base}/setup/machine`)).status).toBe(403);
});

// ---------------------------------------------------------------------------
// Two clocks.
//
// A pairing link is a door into this machine: anyone who can reach the port
// and knows the nonce gets the page. Three minutes is what keeps one left in
// scrollback from staying open. A paste request opens nothing — it is a
// challenge and three facts, printed on purpose for a person to carry to
// another computer — so ending it on the same clock would only punish the
// walk.
// ---------------------------------------------------------------------------

it("keeps the link short-lived and the paste request alive", async () => {
  const session = await pairing({ ttlSeconds: 180 });
  const request = session.pasteRequest();

  clock += 600; // ten minutes: more than three times the link's life

  // The link is a door into this machine, and it is gone.
  expect((await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" })).status).toBe(403);
  // The paste request opens nothing, and is still good.
  expect(session.pasteRequest()).toBe(request);
});

it("carries exactly the fields the redirect carries", async () => {
  const session = await pairing();
  const request = decodeRequest(session.pasteRequest());

  expect(request).toEqual({
    name: hostname(),
    platform: platformTag(),
    version: DAEMON_VERSION,
    challenge: session.challenge,
    state: session.state,
    // The same callback `/connect`'s redirect names. A machine reached over
    // SSH cannot open it, but the lab still checks it is loopback and the
    // daemon still recognises its own — so what changes on this path is who
    // carries the answer, not what the answer is about.
    redirect: `${session.base}/paired`,
  });
});

it("does not rotate a request somebody has walked away with", async () => {
  // The failure this guards: a researcher pastes the line into a laptop on
  // the other side of the building, approves it, walks back — and the daemon
  // has replaced the challenge they just approved, so the code they carry
  // redeems against a verifier that no longer exists.
  //
  // A session with no paste request out DOES rotate on this same clock; that
  // is what "keeps the port it was reached on when a request is replaced"
  // above proves at this very ttl.
  const announced: string[] = [];
  const session = await pairing({ ttlSeconds: 0.05, onRequestExpired: (link) => announced.push(link) });

  // Snapshotted rather than assumed empty: what matters is that nothing
  // rotates from the moment the request is taken, not what happened in the
  // milliseconds before it.
  const request = session.pasteRequest();
  const challengeThen = session.challenge;
  const announcedThen = announced.length;

  await new Promise((resolve) => setTimeout(resolve, 400)); // eight ttls

  expect(session.pasteRequest()).toBe(request);
  expect(session.challenge).toBe(challengeThen);
  expect(announced.length).toBe(announcedThen);
});

it("rotates it anyway when something asks for a new request outright", async () => {
  // The timer is stopped; `rotateRequest` is not. Expiring is the flow
  // deciding nobody is coming, which is exactly the judgement a printed
  // paste request contradicts — but a caller that asks for a fresh request
  // by name has said the old one is finished.
  const session = await pairing();
  const first = session.pasteRequest();
  session.rotateRequest();
  expect(session.pasteRequest()).not.toBe(first);
});

// ---------------------------------------------------------------------------
// The code, carried back by hand.
// ---------------------------------------------------------------------------

it("turns a code carried back by hand into a token, by the exchange the callback makes", async () => {
  let presented = "";
  const lab = await stubLab({
    expectVerifier: (verifier) => {
      presented = verifier;
      return true;
    },
  });
  const session = await pairing({ lab: lab.base });
  const request = decodeRequest(session.pasteRequest());

  const paired = await session.redeemCode("a-code-from-the-lab");

  expect(paired.machineName).toBe("ana-macbook");
  expect(readState(session.dataDir)?.token).toBe("a-machine-token");
  // The daemon goes on with its life from here exactly as it does when a
  // browser carries the code back: `paired` is what `runServe` is waiting on.
  await expect(session.paired).resolves.toEqual(paired);
  // And what the lab was given redeems what the researcher was shown — the
  // one thing that would silently be a different pairing request.
  expect(createHash("sha256").update(presented).digest("base64url")).toBe(request?.challenge);
});

it("refuses a code when nothing has said which lab to join", async () => {
  const session = await pairing();
  await expect(session.redeemCode("a-code")).rejects.toThrow(/which lab/i);
});

it("refuses a second code once this machine has paired", async () => {
  const lab = await stubLab({ expectVerifier: () => true });
  const session = await pairing({ lab: lab.base });
  await session.redeemCode("the-first");
  await expect(session.redeemCode("a-second")).rejects.toThrow(/already paired/i);
});

it("says what the lab said when an exchange is refused, and stays open for another", async () => {
  const lab = await labServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "that code has expired" }));
  });
  const session = await pairing({ lab: lab.base });
  const before = session.challenge;

  await expect(session.redeemCode("stale")).rejects.toThrow(/expired/i);
  // Unsettled on purpose, the same way `/paired` leaves it: a refused
  // exchange is not a refused request, and the request this session holds is
  // still the one that would succeed on a second try.
  expect(session.challenge).toBe(before);
});

it("prints instructions a person can follow from another computer", () => {
  // Everything somebody needs and nothing they have to work out: which lab,
  // what this machine will be called there, the address to open, the line to
  // paste, and the one command that finishes it. A machine reached over SSH
  // is the whole audience, so nothing here assumes a browser is nearby.
  const printed = pasteInstructions("https://lab.example.edu", "gpu-box", "LYK1.abcdef");

  expect(printed).toContain('This machine needs to join https://lab.example.edu as "gpu-box".');
  expect(printed).toContain("https://lab.example.edu/#/pair");
  expect(printed).toContain("LYK1.abcdef");
  expect(printed).toContain("lykeion pair --code");
});

it("names the lab once, without a trailing slash doubling the one in the address", () => {
  const printed = pasteInstructions("https://lab.example.edu/", "gpu-box", "LYK1.abcdef");
  expect(printed).toContain("https://lab.example.edu/#/pair");
  expect(printed).not.toContain("edu//#/pair");
});

// ---------------------------------------------------------------------------
// The one decision that is the researcher's alone.
//
// Whether to run an adapter neither the agent's vendor nor the ACP project
// published. It is recorded here, in this machine's own data directory beside
// its pairing token, because it decides what runs next to a credential only
// this account may read — a lab on another computer can show the terms and
// must not be able to answer them.
// ---------------------------------------------------------------------------

it("says whether a decision is outstanding, beside who is signed in", async () => {
  const session = await pairing({
    authStates: async () => [
      { agent: "claude", name: "Claude Code", available: true, signedIn: true },
    ],
  });
  const cookie = await admit(session);

  const res = await fetch(`${session.base}/agents`, { headers: { cookie } });
  const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
  const claude = body.agents.find((a) => a.agent === "claude")!;

  // Whether an adapter resolved on this machine decides what is knowable
  // here. What must always be true is that the page is never left guessing:
  // a key that is absent is absent, never a default that reads as an answer.
  expect("consentNeeded" in claude ? typeof claude.consentNeeded : "absent").not.toBe("string");
  expect(claude.signedIn).toBe(true);
});

it("records an acceptance against the declared adapter, not one a page named", async () => {
  // The page says which AGENT was allowed and nothing else. Letting it name
  // the command would let whatever can reach this route write an acceptance
  // for a program this machine never declared — and the acceptance is what
  // rung 6 reads before spawning anything.
  const session = await pairing();
  const cookie = await admit(session);

  const res = await fetch(`${session.base}/agents/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agent: "claude", command: "anything-i-like", accepted: true }),
  });

  expect(res.status).toBe(200);
  const written = acceptedAdapters(session.dataDir);
  expect(written.has(consentKey("claude", "anything-i-like"))).toBe(false);
});

it("refuses a consent that did not come from this daemon's own page", async () => {
  const session = await pairing();
  const res = await fetch(`${session.base}/agents/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "claude", accepted: true }),
  });
  expect(res.status).toBe(403);
});

it("takes an acceptance back", async () => {
  const session = await pairing();
  const cookie = await admit(session);
  const post = (accepted: boolean) =>
    fetch(`${session.base}/agents/consent`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude", accepted }),
    });

  expect((await post(true)).status).toBe(200);
  expect((await post(false)).status).toBe(200);
  // Whatever key the declaration produced, revoking leaves none of it behind:
  // an acceptance that could be given and not taken back would be a decision
  // with no way out of it.
  expect(acceptedAdapters(session.dataDir).size).toBe(0);
});

// ---------------------------------------------------------------------------
// The link opens the first run, not a page beside it.
//
// `/paired` was taught to serve the application at step 3 so a researcher
// coming back from a lab lands on the step that was waiting. The link the
// daemon prints is the other end of the same journey, and it was still
// answering with a page of the daemon's own — so the flow those three steps
// describe could not be reached from the one address that is printed.
// ---------------------------------------------------------------------------

/** A built application with a real `<html>` element, which is what the step
 *  mark is written onto. `builtUi()` above is deliberately the barest file
 *  that proves a build exists, and has no element to mark. */
function markableUi(): string {
  const dir = freshDir();
  writeFileSync(join(dir, "index.html"), '<!doctype html><html lang="en"><body></body></html>');
  return dir;
}

it("opens the first run on the link it prints, at step 1", async () => {
  const session = await pairing({ uiDir: markableUi() });
  const res = await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" });
  expect(res.status).toBe(200);
  const body = await res.text();
  // The application, marked with the step it opens on — the same mechanism
  // `/paired` uses, so one function decides how a step is carried.
  expect(body).toContain("<html");
  expect(body).toContain('data-setup-step="1"');
});

it("opens a paired machine's own page on step 3, where signing agents in is", async () => {
  const session = await pairing({
    uiDir: markableUi(),
    alreadyPaired: ALREADY_PAIRED,
  });
  const body = await (await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" })).text();
  expect(body).toContain('data-setup-step="3"');
});

it("still renders its own page when there is no application to serve", async () => {
  // A daemon running from source with nothing built has a real pairing
  // request to show and no page to show it on. Its own page is the answer,
  // exactly as it was — this adds a better surface, it does not remove the
  // one that works everywhere.
  const session = await pairing({ uiDir: freshDir() });
  const body = await (await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" })).text();
  expect(body).toContain("Lykeion lab address");
  expect(body).toContain("Machine name");
});

it("stops asking where the lab lives once one is running here", async () => {
  // The question step 1 asks is answered the moment a lab comes up behind this
  // daemon. Serving step 1 again would ask a researcher where their lab lives
  // while it is already running behind the page they are reading — and what
  // comes next, creating the owner account IN it, is behind the auth gate
  // rather than in the wizard's own route.
  const lab = await labServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const session = await pairing({ uiDir: markableUi(), forward: forwardTo(Number(new URL(lab.base).port)) });

  const body = await (await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" })).text();
  expect(body).not.toContain("data-setup-step");
  // And it declares the workspace, so the page reaches the lab rather than
  // running its own in-browser demo against a machine that has a real one.
  expect(body).toContain('name="lykeion-workspace"');
});

it("declares no workspace while there is no lab behind this daemon", async () => {
  // The other half, and the one that must not be got wrong: a daemon whose lab
  // is on another computer forwards none of the lab's routes through this
  // origin, so a page told it had a workspace here would call /rpc on a door
  // that answers 404.
  const session = await pairing({ uiDir: markableUi() });
  const body = await (await fetch(`${session.base}/?nonce=${session.nonce}`, { redirect: "manual" })).text();
  expect(body).toContain('data-setup-step="1"');
  expect(body).not.toContain('name="lykeion-workspace"');
});

it("stops the request expiring once the researcher is filling in the form that creates the lab", async () => {
  // The failure this prevents was silent and cost the whole pairing. Answering
  // "here" starts a lab and hands the researcher a form — name, email,
  // password — and from this process that looks exactly like nobody arriving.
  // Rotating retires the cookie their open page holds, so `/setup/paired`
  // refuses the very exchange this flow exists to make: the lab is created,
  // the machine does not join it, and nothing on screen says so.
  const announced: string[] = [];
  const session = await pairing({
    ttlSeconds: 0.05,
    onRequestExpired: (link) => announced.push(link),
    onLabHere: async () => {},
  });
  const cookie = await admit(session);

  expect(
    (
      await fetch(`${session.base}/setup/topology`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ topology: "here" }),
      })
    ).status,
  ).toBe(200);
  // Snapshotted AFTER the answer, because that is where the claim starts:
  // nothing rotates from the moment the topology is recorded. Taken before,
  // this test also asserts that nothing rotated DURING the request — which is
  // the ordinary clock doing its job on a 50ms lease, and on a loaded machine
  // it fails for the one reason this test is not about.
  const held = session.state;
  const announcedThen = announced.length;

  await new Promise((resolve) => setTimeout(resolve, 400)); // eight ttls

  expect(session.state).toBe(held);
  expect(announced.length).toBe(announcedThen);
  // And the page that is still open can still be heard.
  expect((await fetch(`${session.base}/setup/machine`, { headers: { cookie } })).status).toBe(200);
});

it("goes on expiring for a researcher who said the lab is somewhere else", async () => {
  // The other answer commits nothing on this machine and leaves for a lab
  // that will do its own asking, so the ordinary clock is right: a request
  // nobody came back to should be replaced.
  const announced: string[] = [];
  const session = await pairing({
    ttlSeconds: 0.05,
    onRequestExpired: (link) => announced.push(link),
  });
  const cookie = await admit(session);
  await fetch(`${session.base}/setup/topology`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ topology: "elsewhere" }),
  });

  await waitFor(() => announced.length > 0, "the request to expire");
});

it("starts the clock again when a researcher answers the first question", async () => {
  // `touchDeadline`'s own rule — every step that shows somebody is still
  // working through the flow — applied to a step that was never wired to it.
  // Without this the time to type a lab address into step 2 was whatever was
  // left over from reading step 1, and running out silently retired the
  // cookie the open page holds: the next submit is refused, and what it says
  // is to go and run a command.
  let clockNow = 1_000;
  const session = await startPairing({
    port: 0,
    dataDir: freshDir(),
    ttlSeconds: 180,
    now: () => clockNow,
    authStates: async () => [],
    uiDir: freshDir(),
  });
  sessions.push(session);
  const cookie = await admit(session);

  clockNow += 170; // nearly out, the way reading step 1 spends it
  expect(
    (
      await fetch(`${session.base}/setup/topology`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ topology: "elsewhere" }),
      })
    ).status,
  ).toBe(200);

  // The nonce is not rotated by answering, so the page keeps its admission —
  // and the span it has for the next step starts over rather than being what
  // was left of the last one.
  expect((await fetch(`${session.base}/setup/machine`, { headers: { cookie } })).status).toBe(200);
});

// ---------------------------------------------------------------------------
// The list this machine's own page shows is the list the lab shows.
//
// `/agents` answered only for entries carrying an isolation declaration — two
// of the twelve — while Machines shows what `probeAgentClis` walks, which is
// the whole catalogue. So the first run counted "All 2" and the workbench the
// researcher reached a moment later counted "All 12", about the same computer.
// ---------------------------------------------------------------------------

it("lists every agent the lab lists, not only the two it can ask about", async () => {
  const session = await pairing({
    authStates: async () => [
      { agent: "claude", name: "Claude Code", available: true, signedIn: true },
    ],
  });
  const cookie = await admit(session);

  const body = (await (await fetch(`${session.base}/agents`, { headers: { cookie } })).json()) as {
    agents: { agent: string }[];
  };

  // Catalogue order, so the two lists read the same top to bottom as well as
  // counting the same.
  expect(body.agents.map((a) => a.agent)).toEqual(CATALOGUE.map((entry) => entry.id));
});

it("says nothing about the sign-in of an agent nothing can ask", async () => {
  // An entry with no isolation declaration has no confined home to ask from,
  // so there is no sign-in question to answer. Absent, never `false`: `false`
  // is what puts a Sign in control on a row, and pressing it there would
  // spawn nothing.
  const session = await pairing({
    authStates: async () => [
      { agent: "claude", name: "Claude Code", available: true, signedIn: false },
    ],
  });
  const cookie = await admit(session);

  const body = (await (await fetch(`${session.base}/agents`, { headers: { cookie } })).json()) as {
    agents: Record<string, unknown>[];
  };
  const asked = body.agents.find((a) => a.agent === "claude")!;
  const notAsked = body.agents.find((a) => a.agent === "kiro")!;

  expect(asked.signedIn).toBe(false);
  expect("signedIn" in notAsked).toBe(false);
  // It is still a real row with a real name, because the lower half of that
  // screen is a shopping list and a row with no name is not on it.
  expect(notAsked.name).toBe("Kiro");
  expect(typeof notAsked.available).toBe("boolean");
});

it("keeps the request alive for as long as somebody has the page open", async () => {
  // The bug this closes, found by leaving a browser on the first question:
  // the request expired while a researcher was reading it, the nonce rotated,
  // and the cookie their tab was holding stopped being recognised — so every
  // control on the page went quiet with nothing said.
  const announced: string[] = [];
  const session = await pairing({
    ttlSeconds: 0.15,
    onRequestExpired: (link) => announced.push(link),
  });
  const cookie = await admit(session);
  const held = session.state;

  // Four pings across a span the request would not have survived untouched.
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      (await fetch(`${session.base}/setup/still-here`, { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(200);
  }

  expect(session.state).toBe(held);
  expect(announced).toHaveLength(0);
  // And the page is still admitted, which is the part that actually broke.
  expect((await fetch(`${session.base}/setup/machine`, { headers: { cookie } })).status).toBe(200);
});

it("goes back to expiring once nobody is looking at it", async () => {
  // The other half, and why holding the clock this way is safe: the page stops
  // saying so the moment the tab is closed, so a request nobody is working
  // through is replaced exactly as it was before.
  const announced: string[] = [];
  const session = await pairing({
    ttlSeconds: 0.05,
    onRequestExpired: (link) => announced.push(link),
  });
  const cookie = await admit(session);
  expect(
    (await fetch(`${session.base}/setup/still-here`, { method: "POST", headers: { cookie } }))
      .status,
  ).toBe(200);

  await waitFor(() => announced.length > 0, "the request to expire once the pings stop");
});

it("refuses a still-here that did not come from this daemon's own page", async () => {
  const session = await pairing();
  expect((await fetch(`${session.base}/setup/still-here`, { method: "POST" })).status).toBe(403);
});
