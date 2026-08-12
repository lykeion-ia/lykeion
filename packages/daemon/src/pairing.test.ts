import { afterEach, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";
import { PairingRefused, startPairing, type PairingSession } from "./pairing";
import { readState, type PairedState } from "./state";
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
  expect(body).toContain("lykeion-daemon status");
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
  expect(res.status).toBe(302);

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
  expect(body).toContain("lykeion-daemon status");
});

it("refuses a nonce older than three minutes", async () => {
  const session = await pairing();
  clock += 181;
  const res = await fetch(`${session.base}/?nonce=${session.nonce}`);
  expect(res.status).toBe(403);
  const body = await res.text();
  expect(body).toContain("This link has expired");
  expect(body).toContain("lykeion-daemon status");
});

it("serves the setup page to a tab admitted by cookie, without a nonce", async () => {
  const session = await pairing();
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
  expect(res.status).toBe(302);
  const target = new URL(res.headers.get("location")!);
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
  const session = await pairing();
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

  expect(res.status).toBe(302);
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
  expect(fastConnect.status).toBe(302);
  expect(new URL(fastConnect.headers.get("location")!).origin).toBe(fast.base);

  await sleep(450);
  releaseSlowHead();
  const lateSlow = await slowConnect;
  expect(lateSlow.status).toBe(409);
  expect(lateSlow.headers.get("location")).toBeNull();
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
  expect(res.headers.get("location")).toBeNull();
  expect(await res.json()).toEqual({ error: "run lykeion-daemon status for a fresh link" });

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
  const session = await pairing({ lab: lab.base });
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
  const session = await pairing({ lab: lab.base });
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
  // only that — so the fresh link `status` now mints for a paired daemon
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
  });
  verifier = session.verifier;
  // The tab that carried pairing through, and the cookie it still holds.
  const paired = await admit(session);
  expect(
    (await fetch(`${session.base}/paired?code=abc&state=${session.state}`, { headers: { cookie: paired } }))
      .status,
  ).toBe(200);

  // Months later: `lykeion-daemon status` mints a fresh admission link, and a
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
  expect(await res.json()).toEqual({ agents });
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
  const body = (await res.json()) as { agents: unknown[] };
  expect(Array.isArray(body.agents)).toBe(true);
  for (const agent of body.agents) {
    expect(agent).toMatchObject({
      agent: expect.any(String),
      // Carried over the wire, not only computed: the page's own poll reads
      // this answer, and a row it cannot tell "not installed" from "signed
      // out" for is a row it offers a dead button on.
      available: expect.any(Boolean),
      signedIn: expect.any(Boolean),
    });
  }
});

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
