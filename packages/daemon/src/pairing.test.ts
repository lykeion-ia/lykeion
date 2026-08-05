import { afterEach, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingRefused, startPairing, type PairingSession } from "./pairing";
import { readState } from "./state";

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
  options: { lab?: string; ttlSeconds?: number; onRequestExpired?: (link: string) => void } = {},
): Promise<PairingSession> {
  const session = await startPairing({
    port: 0,
    dataDir: freshDir(),
    lab: options.lab,
    ttlSeconds: options.ttlSeconds,
    onRequestExpired: options.onRequestExpired,
    now: () => clock,
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
  expect(await res.text()).toContain("refused");
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
  expect(body).toContain("expired");
  // The other answer is for a callback that was never this machine's, and
  // telling the two apart is the whole reason the previous state is kept.
  expect(body).not.toContain("did not come from this machine");
});

it("does not mistake an unrelated callback for an expired one", async () => {
  const session = await pairing();
  session.rotateRequest();
  const body = await (await fetch(`${session.base}/paired?code=abc&state=never-minted-here`)).text();
  expect(body).toContain("did not come from this machine");
  expect(body).not.toContain("expired");
});

it("gives the researcher a full span again when they leave for the lab", async () => {
  // Reaching the lab, signing in to it and reading the approval screen all
  // happen where this daemon cannot see, so the handoff restarts the clock
  // rather than spending what filling in the form already cost. Timed
  // against the real one: the span this pushes is a real timer, and a test
  // driving the injected clock instead would pass whether it pushed or not.
  const announced: string[] = [];
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
    body: JSON.stringify({ lab: "https://lab.uni.edu", name: "ana-macbook" }),
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
  expect((await fetch(`${session.base}/`)).status).toBe(403);
});

it("refuses a nonce older than three minutes", async () => {
  const session = await pairing();
  clock += 181;
  expect((await fetch(`${session.base}/?nonce=${session.nonce}`)).status).toBe(403);
});

it("serves the setup page to a tab admitted by cookie, without a nonce", async () => {
  const session = await pairing();
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/`, { headers: { cookie } });
  expect(res.status).toBe(200);
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
  const session = await pairing();
  const cookie = await admit(session);
  const res = await fetch(`${session.base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: "https://lab.uni.edu", name: "ana-macbook" }),
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const target = new URL(res.headers.get("location")!);
  const params = new URLSearchParams(target.hash.slice(target.hash.indexOf("?")));
  expect(target.origin).toBe("https://lab.uni.edu");
  expect(params.get("name")).toBe("ana-macbook");
  expect(params.get("challenge")).toBe(session.challenge);
  expect(params.get("state")).toBe(session.state);
  expect(params.get("redirect")).toBe(`${session.base}/paired`);
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
  expect(await res.text()).toContain("own pairing session");
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

it("says on the page which lab the machine now belongs to", async () => {
  let verifier = "";
  const lab = await stubLab({ expectVerifier: (v) => v === verifier, labName: "Ana's Lab" });
  const session = await pairing({ lab: lab.base });
  verifier = session.verifier;
  const res = await fetch(`${session.base}/paired?code=abc&state=${session.state}`);
  expect(await res.text()).toContain("ana-macbook is now paired with Ana&#39;s Lab.");
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
  expect(body).toContain(`ana-macbook is now paired with ${lab.base}.`);
  expect(body).not.toContain("paired with .");
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
  expect(await res.text()).toContain("own pairing session");
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
