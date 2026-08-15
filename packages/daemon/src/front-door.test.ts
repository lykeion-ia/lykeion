import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { forwardTo, serveApp } from "./front-door";
import { FORWARDED_PREFIXES } from "@lykeion/api/routes";

function uiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-ui-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Lykeion</title>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

it("answers an unknown path with the application, so deep links work", async () => {
  const { status, body, headers } = await request(serveApp, uiDir(), "/start");
  expect(status).toBe(200);
  expect(headers["content-type"]).toContain("text/html");
  expect(body).toContain("<title>Lykeion</title>");
});

it("answers an asset with the asset and its own type", async () => {
  const { status, headers } = await request(serveApp, uiDir(), "/assets/app.js");
  expect(status).toBe(200);
  expect(headers["content-type"]).toContain("javascript");
});

it("never answers a forwarded prefix with the application", async () => {
  // The exact bug dev-proxy.test.ts records: `/runs/:id/events` answered with
  // index.html, and EventSource refused a body that was not text/event-stream.
  for (const { prefix } of FORWARDED_PREFIXES) {
    const answered = await handled(serveApp, uiDir(), `${prefix}/anything`);
    expect(answered, `${prefix} must not fall through to the SPA`).toBe(false);
  }
});

it("never answers a forwarded prefix written some other way", async () => {
  // Whether a path belongs to the lab is a route question, and every route
  // table that will read this path — the daemon's own, and the lab's once a
  // request is forwarded — reads it collapsed: `/x/../runs/abc/events` is
  // `/runs/abc/events`. An `EventSource` handed an HTML body does not care
  // which spelling brought it back.
  for (const { prefix } of FORWARDED_PREFIXES) {
    for (const spelling of [`/x/..${prefix}/anything`, `/%2e${prefix}/anything`, `${prefix}/`]) {
      const answered = await handled(serveApp, uiDir(), spelling);
      expect(answered, `${spelling} must not fall through to the SPA`).toBe(false);
    }
  }
});

it("refuses to climb out of the ui directory", async () => {
  const { status } = await request(serveApp, uiDir(), "/../../etc/passwd");
  expect(status).not.toBe(200);
});

it("refuses to climb out however the climb is spelled", async () => {
  // The literal `..` above survives a check that reads the text of the
  // request instead of resolving it — `target.includes("..")` passes that
  // test and is walked around by this one. Refusing after `resolve` is what
  // makes the two the same question.
  const { status } = await request(serveApp, uiDir(), "/%2e%2e/%2e%2e/etc/passwd");
  expect(status).not.toBe(200);
});

it("refuses a sibling directory whose name begins with the ui directory's", async () => {
  // The separator in the boundary comparison is what earns this one:
  // `…/lykeion-ui-ab-evil` starts with `…/lykeion-ui-ab` and is not inside
  // it, so `startsWith(root)` alone would hand the file over.
  const dir = uiDir();
  mkdirSync(`${dir}-evil`);
  writeFileSync(join(`${dir}-evil`, "secret"), "not the application's to serve");
  const { status } = await request(serveApp, dir, `/../${basename(dir)}-evil/secret`);
  expect(status).toBe(403);
});

it("refuses a symlink that leads out of the ui directory", async () => {
  // `statSync` and `createReadStream` follow links and a lexical comparison
  // does not, so the path is resolved through its links before it is judged.
  const dir = uiDir();
  const outside = mkdtempSync(join(tmpdir(), "lykeion-elsewhere-"));
  writeFileSync(join(outside, "secret"), "not the application's to serve");
  symlinkSync(outside, join(dir, "elsewhere"));
  const { status } = await request(serveApp, dir, "/elsewhere/secret");
  expect(status).toBe(403);
});

it("leaves anything that is not a GET to the routes behind it", async () => {
  // The front door stands in front of a 404, and the daemon has routes that
  // exist only for part of a session — `POST /connect` on a machine that has
  // already paired is meant to answer that it does not exist here. Answering
  // a POST with the application would turn every one of those refusals into
  // a 200 carrying a page the caller cannot use.
  expect(await handled(serveApp, uiDir(), "/start", { method: "POST" })).toBe(false);
});

it("marks the page with the step the wizard must open on when asked to", async () => {
  const { status, body } = await request(serveApp, builtUiDir(), "/paired", { step: 3 });
  expect(status).toBe(200);
  expect(body).toContain('data-setup-step="3"');
  // The attribute is added to the tag, not written over what was there.
  expect(body).toContain('lang="en"');
});

it("serves the page byte for byte when no step is asked for", async () => {
  const { body } = await request(serveApp, builtUiDir(), "/");
  expect(body).toBe(BUILT_INDEX_HTML);
});

it("serves the page unchanged when the build no longer has the tag it knew", async () => {
  // A daemon that refuses to serve its own page because a build changed shape
  // is worse than one that opens on step 1.
  const { status, body } = await request(serveApp, uiDir(), "/paired", { step: 3 });
  expect(status).toBe(200);
  expect(body).toBe("<!doctype html><title>Lykeion</title>");
});

it("says so plainly when the application has never been built", async () => {
  // The one way to reach this: a daemon run from a tree whose UI has not been
  // built. "No such route" would send whoever hit it looking at routing.
  const empty = mkdtempSync(join(tmpdir(), "lykeion-ui-"));
  const { status, body } = await request(serveApp, empty, "/start");
  expect(status).toBe(404);
  expect(body).toContain("has not been built");
});

it("hands a stream on to the browser as it arrives rather than holding it", async () => {
  // `/events` and `/runs/:id/events` are held open for as long as the tab is:
  // the lab below never ends this response. A proxy that buffered would have
  // nothing to give the browser until then, so this read would time out
  // rather than fail — which is what a live turn rendering nothing looks like.
  const lab = await serverOn((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
  });
  const front = await serverOn(forwardTo(lab.port));
  const client = httpRequest({ host: "127.0.0.1", port: front.port, path: "/events" });
  try {
    const opened = await new Promise<{ res: IncomingMessage; chunk: string }>((resolve, reject) => {
      client.on("error", reject);
      client.on("response", (res) => {
        res.setEncoding("utf8");
        res.once("data", (chunk: string) => resolve({ res, chunk }));
      });
      client.end();
    });
    expect(opened.res.statusCode).toBe(200);
    expect(opened.res.headers["content-type"]).toBe("text/event-stream");
    expect(opened.chunk).toContain("data: one");
  } finally {
    client.destroy();
    await front.close();
    await lab.close();
  }
});

it("closes the browser's connection when the lab's answer is cut off", async () => {
  // A lab restart, routine while somebody is developing one. `pipe` finishes
  // the response only on a clean end, so without this the tab is left holding
  // a connection that never closes — and `EventSource` reconnects on a
  // connection that closed, not on one that went quiet.
  const lab = await serverOn((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => res.destroy(), 20);
  });
  const front = await serverOn(forwardTo(lab.port));
  const client = httpRequest({ host: "127.0.0.1", port: front.port, path: "/events" });
  try {
    const outcome = await new Promise<{ closed: boolean; body: string }>((resolve) => {
      let body = "";
      const closed = () => resolve({ closed: true, body });
      client.on("error", closed);
      client.on("response", (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("close", closed);
      });
      // Long enough to be sure this is a connection that is never closing,
      // rather than one still on its way. A proxy that does not carry the cut
      // across fails here by waiting the whole of it out.
      setTimeout(() => resolve({ closed: false, body }), 2000);
      client.end();
    });
    expect(outcome.closed).toBe(true);
    // And nothing was appended to a body already under way: a 502's JSON
    // arriving inside a `text/event-stream` is worse than silence.
    expect(outcome.body).toBe("data: one\n\n");
  } finally {
    client.destroy();
    await front.close();
    await lab.close();
  }
});

it("says nothing at all when the lab's answer fails after it has begun", async () => {
  // A 502's JSON appended to a body already under way is not a 502. The tab
  // is reading `text/event-stream` and what it would get is an event that is
  // not one, on top of a status it was told long ago. Once the headers are
  // out the only honest thing left is to stop.
  // Raw, because the answer has to stop being valid HTTP partway through and
  // `node:http` cannot be talked into writing something it would not parse.
  let held: Socket | undefined;
  const lab = createNetServer((socket) => {
    held = socket;
    socket.write(
      "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n",
    );
    socket.write("b\r\ndata: one\n\n\r\n");
    // A chunk length that is not one, so the answer stops being an answer
    // partway through — the shape a lab dying mid-stream leaves behind.
    setTimeout(() => socket.write("nonsense\r\n"), 20);
  });
  await new Promise<void>((ready) => lab.listen(0, "127.0.0.1", ready));
  const labPort = (lab.address() as { port: number }).port;
  const front = await serverOn(forwardTo(labPort));
  const client = httpRequest({ host: "127.0.0.1", port: front.port, path: "/events" });
  try {
    const body = await new Promise<string>((resolve) => {
      let seen = "";
      const done = () => resolve(seen);
      client.on("error", done);
      client.on("response", (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (seen += chunk));
        res.on("close", done);
      });
      setTimeout(done, 2000);
      client.end();
    });
    expect(body).toBe("data: one\n\n");
  } finally {
    client.destroy();
    held?.destroy();
    await front.close();
    await new Promise<void>((closed) => lab.close(() => closed()));
  }
});

it("tells the lab the address the lab itself answers on", async () => {
  // Not the address the browser typed. See `forwardTo` for what that buys.
  let seen: string | undefined;
  const lab = await serverOn((req, res) => {
    seen = req.headers.host;
    res.writeHead(204).end();
  });
  const front = await serverOn(forwardTo(lab.port));
  try {
    await fetchRaw(front.port, "/rpc", { headers: { host: "lykeion.example:1420" } });
    expect(seen).toBe(`127.0.0.1:${lab.port}`);
  } finally {
    await front.close();
    await lab.close();
  }
});

// --- helpers ---------------------------------------------------------------

const BUILT_INDEX_HTML =
  '<!doctype html>\n<html lang="en">\n  <head></head>\n  <body></body>\n</html>\n';

/** A directory shaped like the one Vite actually builds, whose opening tag is
 *  the `<html lang="en">` the step seam substitutes on. */
function builtUiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-ui-"));
  writeFileSync(join(dir, "index.html"), BUILT_INDEX_HTML);
  return dir;
}

type Answer = { status: number; body: string; headers: IncomingHttpHeaders };

/** Runs one request through `serveApp` on a real loopback server, because the
 *  path it has to defend against — `/../../etc/passwd` — is one `fetch` would
 *  normalise away before it ever reached the daemon. `node:http` sends the
 *  request target exactly as written. */
async function answerOf(
  serve: typeof serveApp,
  dir: string,
  path: string,
  options: { method?: string; step?: number } = {},
): Promise<Answer & { answered: boolean }> {
  let answered = false;
  const front = await serverOn((req, res) => {
    answered = serve(req, res, dir, options.step);
    if (!answered) res.writeHead(404, { "content-type": "text/plain" }).end("no such route");
  });
  try {
    const answer = await fetchRaw(front.port, path, { method: options.method });
    return { ...answer, answered };
  } finally {
    await front.close();
  }
}

async function request(
  serve: typeof serveApp,
  dir: string,
  path: string,
  options: { method?: string; step?: number } = {},
): Promise<Answer> {
  return await answerOf(serve, dir, path, options);
}

async function handled(
  serve: typeof serveApp,
  dir: string,
  path: string,
  options: { method?: string; step?: number } = {},
): Promise<boolean> {
  return (await answerOf(serve, dir, path, options)).answered;
}

async function serverOn(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function fetchRaw(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
