import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBodyReader, startServer } from "./http";
import { readConfig } from "./config";

const running: Array<{ close: () => Promise<void> }> = [];
const dirs: string[] = [];
const controllers: AbortController[] = [];

async function freshServer() {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-http-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><head></head><body></body>");
  const server = await startServer({
    ...readConfig({}),
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    uiDir,
  });
  running.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

/**
 * A server actually serving TLS, with a throwaway self-signed certificate.
 * `openssl` is present on every platform this server targets, and shelling
 * out for a one-day certificate is far less code than assembling one.
 */
async function tlsServer() {
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "lykeion-tls-"));
  dirs.push(dir);
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ]);

  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><head></head><body></body>");
  const server = await startServer({
    ...readConfig({}),
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    uiDir,
    tlsCertPath: certPath,
    tlsKeyPath: keyPath,
  });
  running.push(server);
  return { server, base: `https://127.0.0.1:${server.port}` };
}

afterEach(async () => {
  // Aborted before the server closes underneath it: an open `/events`
  // fetch left dangling is exactly the unclosed stream that keeps this
  // file's process alive past the last test.
  for (const c of controllers.splice(0)) c.abort();
  for (const s of running.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface SseFrame {
  event: string;
  data: string;
}

function parseFrames(raw: string): SseFrame[] {
  return raw
    .split("\n\n")
    .filter((block) => block.trim().length > 0 && !block.startsWith(":"))
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) data += line.slice("data: ".length);
      }
      return { event, data };
    });
}

/**
 * Reads whole SSE frames off `/events` as they arrive, buffering a partial
 * one until it completes and skipping heartbeat comments. Every stream this
 * opens is tracked in `controllers` so `afterEach` can abort it even when a
 * test fails before calling `close` itself.
 */
function openEventStream(
  base: string,
  cookie: string,
  cursor?: number,
  resumeVia: "query" | "header" = "query",
) {
  const controller = new AbortController();
  controllers.push(controller);
  const useQuery = cursor !== undefined && resumeVia === "query";
  const url = useQuery ? `${base}/events?cursor=${cursor}` : `${base}/events`;
  const headers: Record<string, string> = { cookie };
  if (cursor !== undefined && resumeVia === "header") headers["last-event-id"] = String(cursor);
  const opened = fetch(url, { headers, signal: controller.signal });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: SseFrame[] = [];

  async function pump(): Promise<boolean> {
    if (!reader) reader = (await opened).body!.getReader();
    const { value, done } = await reader.read();
    if (done) return false;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      queue.push(...parseFrames(block));
    }
    return true;
  }

  return {
    async status(): Promise<number> {
      return (await opened).status;
    },
    async next(): Promise<SseFrame> {
      while (queue.length === 0) {
        const more = await pump();
        if (!more) throw new Error("event stream ended before an event arrived");
      }
      return queue.shift()!;
    },
    close(): void {
      controller.abort();
    },
  };
}

async function setupOwner(base: string): Promise<string> {
  const res = await fetch(`${base}/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ana@lab.example", displayName: "Ana", password: "a good long password" }),
  });
  return res.headers.get("set-cookie")!.split(";")[0];
}

it("refuses an RPC call from nobody", async () => {
  const { base } = await freshServer();
  const res = await fetch(`${base}/rpc/listStudies`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: [] }),
  });
  expect(res.status).toBe(401);
});

it("answers a signed-in call with a success envelope", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);
  const res = await fetch(`${base}/rpc/currentUser`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: [] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; value: { email: string } };
  expect(body.ok).toBe(true);
  expect(body.value.email).toBe("ana@lab.example");
});

it("refuses anything but POST on an rpc path", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);
  const res = await fetch(`${base}/rpc/currentUser`, { headers: { cookie } });
  expect(res.status).toBe(405);
});

it("refuses a body that is not JSON", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);
  const res = await fetch(`${base}/rpc/currentUser`, {
    method: "POST",
    headers: { "content-type": "text/plain", cookie },
    body: "args",
  });
  expect(res.status).toBe(415);
});

it("refuses a sign-out that declares no type, and leaves the session standing", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);

  // A request with no body carries no content type, which is the shape the
  // guard turns away. Asserted through the listener rather than against the
  // route, because the guard is the listener's and a route called directly
  // never meets it.
  const refused = await fetch(`${base}/auth/signout`, { method: "POST", headers: { cookie } });
  expect(refused.status).toBe(415);

  // The refusal has to leave the caller signed in. A sign-out that half
  // happened — refused, but the session gone — would be the same defect
  // read from the other side.
  const after = await fetch(`${base}/rpc/currentUser`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: [] }),
  });
  expect(after.status).toBe(200);
});

it("signs out a caller that declares JSON and sends an empty object", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);

  const res = await fetch(`${base}/auth/signout`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}",
  });
  expect(res.status).toBe(200);

  const after = await fetch(`${base}/rpc/currentUser`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: [] }),
  });
  expect(after.status).toBe(401);
});

it("refuses a body over the cap instead of buffering it", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);
  const res = await fetch(`${base}/rpc/currentUser`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: ["x".repeat(2 * 1024 * 1024)] }),
  });
  expect(res.status).toBe(413);
});

it("holds no more than the cap, however much is pushed through it", () => {
  // A 413 does not say the body was refused rather than swallowed: a server
  // that buffers everything and then answers 413 returns the same status,
  // while an unauthenticated caller decides how much to send. Asserting on
  // the process heap cannot separate the two here, because the client that
  // builds the oversized body runs in this same process and dwarfs it.
  const cap = 1024;
  const reader = createBodyReader(cap);
  const chunk = Buffer.alloc(512, "x");

  let peak = 0;
  for (let i = 0; i < 200; i++) {
    reader.push(chunk);
    peak = Math.max(peak, reader.retained());
  }

  expect(peak).toBeLessThanOrEqual(cap);
  expect(reader.finish()).toBe("too-large");
});

it("404s an unknown method rather than dressing it as a contract failure", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);
  const res = await fetch(`${base}/rpc/deleteEverything`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: [] }),
  });
  expect(res.status).toBe(404);
});

it("serves the UI with the marker that tells it a server is behind it", async () => {
  const { base } = await freshServer();
  const html = await (await fetch(base)).text();
  expect(html).toContain('<meta name="lykeion-workspace" content="1">');
});

it("falls back to the UI for an unmatched path, so deep links load", async () => {
  const { base } = await freshServer();
  const res = await fetch(`${base}/studies/s_1`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/html/);
});

it("serves over TLS when a certificate and key are configured", async () => {
  // The bind rule refuses a routable address without TLS. That rule is only
  // worth having if the path it points at actually works.
  const tls = await tlsServer();
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await fetch(`${tls.base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<meta name="lykeion-workspace" content="1">');
  } finally {
    // Restored in a finally, so a failure here cannot leave certificate
    // checking off for every later test in this process.
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

it("marks the session cookie Secure when it is serving TLS, and not when it is not", async () => {
  // A session cookie without Secure is one a downgraded request carries in
  // the clear, which gives away the whole point of having configured TLS.
  // Both directions matter, and only the TLS one is about security — so it
  // is the one that has to run against a server actually serving TLS,
  // rather than against a plain-HTTP server asserting the easy half.
  const plain = await freshServer();
  const overHttp = await fetch(`${plain.base}/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@l.example", displayName: "A", password: "password one" }),
  });
  expect(overHttp.headers.get("set-cookie")).not.toMatch(/Secure/);

  const tls = await tlsServer();
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const overTls = await fetch(`${tls.base}/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b@l.example", displayName: "B", password: "password two" }),
    });
    expect(overTls.headers.get("set-cookie")).toMatch(/Secure/);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

it("stamps the marker on /index.html too, not only on /", async () => {
  // A bookmark, a proxy, or a link can ask for the document by name. Serving
  // that file straight off disk hands back the unstamped copy, and a browser
  // that cannot find the marker builds the in-browser demo instead — so a
  // researcher on their own lab's address would be shown fabricated studies
  // and lose everything they wrote on the next reload.
  const { base } = await freshServer();
  for (const path of ["/", "/index.html", "/studies/s_1"]) {
    const html = await (await fetch(`${base}${path}`)).text();
    expect(html, `no marker on ${path}`).toContain(
      '<meta name="lykeion-workspace" content="1">',
    );
  }
});

it("refuses to start on a UI whose index.html cannot carry the marker", async () => {
  // Silently serving an unstamped shell is the same data loss as above, and
  // a no-op string replace gives no sign it happened.
  const dir = mkdtempSync(join(tmpdir(), "lykeion-nohead-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><body></body>");
  await expect(
    startServer({ ...readConfig({}), host: "127.0.0.1", port: 0, dataDir: dir, uiDir }),
  ).rejects.toThrow(/no <\/head>/);
});

it("answers a malformed args list as a refusal, not as a crash", async () => {
  // `args` that is not an array is the caller's mistake. Reporting 500 tells
  // them the server fell over, and logs a stack for every one of them.
  const { base } = await freshServer();
  const cookie = await setupOwner(base);
  const res = await fetch(`${base}/rpc/currentUser`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: { 0: "not-an-array" } }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: false,
    error: { code: "invalid", message: "args must be an array" },
  });
});

it("404s a missing asset rather than answering it with the page", async () => {
  // Serving the shell under a script's name surfaces as a MIME error and a
  // blank page, and every uptime probe sees 200.
  const { base } = await freshServer();
  const res = await fetch(`${base}/assets/nothing-here.js`);
  expect(res.status).toBe(404);
});

it("reports a port already in use instead of hanging", async () => {
  // The listen callback never fires on a failed bind, so without an error
  // listener the promise never settles and the process throws from an event
  // nobody handled — on the most ordinary startup problem there is.
  const first = await freshServer();
  const dir = mkdtempSync(join(tmpdir(), "lykeion-busy-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><head></head><body></body>");
  await expect(
    startServer({
      ...readConfig({}),
      host: "127.0.0.1",
      port: first.server.port,
      dataDir: dir,
      uiDir,
    }),
  ).rejects.toThrow(/EADDRINUSE/);
});

it("refuses to serve a UI directory the database sits inside", async () => {
  // Static files are served with no authentication at all, so a data
  // directory under the served root publishes password hashes and live
  // session tokens to anyone who can reach the port.
  const dir = mkdtempSync(join(tmpdir(), "lykeion-overlap-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><head></head><body></body>");
  await expect(
    startServer({
      ...readConfig({}),
      host: "127.0.0.1",
      port: 0,
      dataDir: join(dir, "data"),
      uiDir: dir,
    }),
  ).rejects.toThrow(/sits inside it/);
});

it("refuses an event stream from nobody", async () => {
  const { base } = await freshServer();
  const res = await fetch(`${base}/events`);
  expect(res.status).toBe(401);
});

it("delivers a write made through the RPC endpoint to a subscriber already on the event stream", async () => {
  // This is the whole point of the channel: a change one researcher's tab
  // wrote through /rpc reaches another tab's already-open /events connection
  // without that tab ever asking again.
  const { base } = await freshServer();
  const cookie = await setupOwner(base);

  const stream = openEventStream(base, cookie);
  expect(await stream.status()).toBe(200);

  const created = await fetch(`${base}/rpc/createStudy`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ args: [{ title: "Live", key: "LIV" }] }),
  }).then((r) => r.json() as Promise<{ ok: boolean; value: { id: string } }>);

  const frame = await stream.next();
  expect(frame.event).toBe("change");
  const message = JSON.parse(frame.data) as { kind: string; payload: { studyId: string } };
  expect(message.kind).toBe("study-created");
  expect(message.payload.studyId).toBe(created.value.id);
});

it("replays only what a reconnecting cursor missed, not the whole log again", async () => {
  const { base } = await freshServer();
  const cookie = await setupOwner(base);

  const post = (method: string, args: unknown[]) =>
    fetch(`${base}/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ args }),
    }).then((r) => r.json() as Promise<{ ok: boolean; value: { id: string } }>);

  // Connected before either write, with no cursor: it sees the first
  // creation live, which is what hands this test a real sequence number to
  // resume from — not one it had to assume.
  const early = openEventStream(base, cookie);
  expect(await early.status()).toBe(200);
  const first = await post("createStudy", [{ title: "First", key: "FIR" }]);
  const firstFrame = await early.next();
  const firstSeq = (JSON.parse(firstFrame.data) as { seq: number }).seq;
  early.close();

  const second = await post("createStudy", [{ title: "Second", key: "SEC" }]);

  const resumed = openEventStream(base, cookie, firstSeq);
  const frame = await resumed.next();
  const message = JSON.parse(frame.data) as { kind: string; payload: { studyId: string } };
  expect(message.kind).toBe("study-created");
  expect(message.payload.studyId).toBe(second.value.id);
  expect(message.payload.studyId).not.toBe(first.value.id);
});

it("resumes from the Last-Event-ID a reconnecting browser sends", async () => {
  // The only resume a browser performs. `EventSource` reconnects on its own
  // and replays its last id in this header; nothing in the page sets the
  // query parameter, so a regression here loses every reconnect silently.
  const { base } = await freshServer();
  const cookie = await setupOwner(base);
  const post = (method: string, args: unknown[]) =>
    fetch(`${base}/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ args }),
    }).then((r) => r.json() as Promise<{ ok: boolean; value: { id: string } }>);

  const early = openEventStream(base, cookie);
  expect(await early.status()).toBe(200);
  await post("createStudy", [{ title: "First", key: "FIR" }]);
  const firstSeq = (JSON.parse((await early.next()).data) as { seq: number }).seq;
  early.close();

  const second = await post("createStudy", [{ title: "Second", key: "SEC" }]);

  const resumed = openEventStream(base, cookie, firstSeq, "header");
  const message = JSON.parse((await resumed.next()).data) as {
    payload: { studyId: string };
  };
  expect(message.payload.studyId).toBe(second.value.id);
});

it("ends an open event stream when the server closes, rather than leaving it dangling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-events-close-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><head></head><body></body>");
  const server = await startServer({
    ...readConfig({}),
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    uiDir,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const cookie = await setupOwner(base);

  const stream = openEventStream(base, cookie);
  expect(await stream.status()).toBe(200);

  // `close()` must not hang waiting on the connection this stream still
  // holds open — it has to end that connection itself.
  await server.close();

  await expect(stream.next()).rejects.toThrow(/ended/);
});
