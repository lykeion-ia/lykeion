import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { assertBindable, assertServable, type ServerConfig } from "./config";
import { openStore } from "./store/sqlite";
import { migrate } from "./store/migrations";
import { seedLabContent } from "./store/seed";
import { handleAuthRoute } from "./routes/auth-routes";
import { handleDaemonRoute } from "./routes/daemon-routes";
import { readCookie, resolveActor, SESSION_COOKIE } from "./auth";
import { createWorkspaceApi } from "./api/index";
import { changeRecorder } from "./api/changes";
import { isLykeionError } from "@lykeion/api";
import { dispatch, rpcMethods } from "./rpc";
import type { Store } from "./store/store";
import { createChannel, type Channel, type Send } from "./channel";

const MAX_BODY = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** How the browser learns it is talking to a real lab rather than running
 *  on its own. Injected at serve time, so nothing has to be built twice. */
const MARKER = '<meta name="lykeion-workspace" content="1">';

/**
 * Accumulates a request body up to a cap. Split out from the socket so the
 * one property that matters — that nothing beyond the cap is ever held — can
 * be asserted directly. A caller sending an unbounded body is unauthenticated
 * on the auth routes, so "we buffered it all and then said 413" is not good
 * enough, and a status code cannot tell the two apart.
 */
export function createBodyReader(maxBytes: number) {
  let size = 0;
  let tooLarge = false;
  let chunks: Buffer[] = [];
  return {
    push(chunk: Buffer): void {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    },
    /** Bytes held right now. Never exceeds the cap, whatever was pushed. */
    retained(): number {
      return chunks.reduce((n, c) => n + c.length, 0);
    },
    finish(): string | "too-large" {
      return tooLarge ? "too-large" : Buffer.concat(chunks).toString("utf8");
    },
  };
}

function readBody(req: IncomingMessage): Promise<string | "too-large"> {
  return new Promise((resolve, reject) => {
    const reader = createBodyReader(MAX_BODY);
    // The socket is left to drain rather than destroyed: the sender already
    // committed to writing this whole body without waiting for permission,
    // and tearing the connection down here would race that write and lose
    // the response.
    req.on("data", (chunk: Buffer) => reader.push(chunk));
    req.on("end", () => resolve(reader.finish()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (setCookie) headers["set-cookie"] = setCookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(
  config: ServerConfig,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<RunningServer> {
  assertBindable(config);
  assertServable(config);
  const store = openStore(join(config.dataDir, "workspace.db"));
  migrate(store);
  seedLabContent(store);
  const secure = Boolean(config.tlsCertPath && config.tlsKeyPath);
  const channel = createChannel(store, config.changeLogRetention);
  // Every open `/events` response, so `close()` can end them itself: a
  // stream nobody tears down keeps its heartbeat alive (harmless — it is
  // `unref`'d) but also keeps `server.close()` waiting on a connection that
  // was never going to close on its own.
  const openStreams = new Set<() => void>();

  const rawIndex = readFileSync(join(config.uiDir, "index.html"), "utf8");
  if (!rawIndex.includes("</head>"))
    throw new Error(
      `the UI at ${config.uiDir} has an index.html with no </head>, so the ` +
        `workspace marker cannot be placed in it. Without the marker the ` +
        `browser cannot tell a real lab from the in-browser demo, and would ` +
        `discard everything a researcher wrote.`,
    );
  const indexHtml = rawIndex.replace("</head>", `${MARKER}</head>`);

  const listener = createRequestListener({ store, config, secure, indexHtml, now, channel, openStreams });
  const server = secure
    ? createHttpsServer(
        { cert: readFileSync(config.tlsCertPath!), key: readFileSync(config.tlsKeyPath!) },
        listener,
      )
    : createHttpServer(listener);

  // Without this the promise never settles on a failed bind and the
  // 'error' event throws out of the process — so the most ordinary startup
  // problem there is, a port already in use, reports as a hang.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Before `server.close()`, not after: an open `/events` connection
        // is a request `server.close()` waits on, so ending it here is what
        // lets that promise's callback ever fire.
        for (const end of openStreams) end();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}

export function createRequestListener(deps: {
  store: Store;
  config: ServerConfig;
  secure: boolean;
  indexHtml: string;
  channel: Channel;
  /** Every open `/events` response's teardown, so the server that built this
   *  listener can end them from `close()`. */
  openStreams: Set<() => void>;
  /** Defaults to the real clock; a test pins this to prove ordering
   *  tiebreaks do the work rather than happening to pass on real time. */
  now?: () => number;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, config, secure, indexHtml, channel, openStreams } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path.startsWith("/auth/")) {
        // The same content-type check `/rpc/` makes, and for the same
        // reason: `application/json` is not a CORS-simple type, so a form
        // or a `no-cors` fetch from another site cannot reach these routes
        // without a preflight that nothing here answers. Without it, any
        // page open in the researcher's browser can create the owner of a
        // lab that has not been set up yet, or sign them out of one.
        if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json"))
          return sendJson(res, 415, { error: "auth calls are application/json" });
        const raw = req.method === "POST" ? await readBody(req) : "";
        if (raw === "too-large") return sendJson(res, 413, { error: "that request is too large" });
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          return sendJson(res, 400, { error: "that request body is not JSON" });
        }
        // Nobody is signed in on these routes, so the recorder carries no
        // actor of its own; the one route that records names the member it
        // has just made.
        const authChanges = changeRecorder({ store, actorId: null, now, channel });
        try {
          const result = await handleAuthRoute({
            store, changes: authChanges, method: req.method ?? "GET", path, body,
            cookie: req.headers.cookie, secure, now: now(),
          });
          if (result) return sendJson(res, result.status, result.json, result.setCookie);
          return sendJson(res, 404, { error: "no such route" });
        } finally {
          authChanges.flush();
        }
      }

      if (path.startsWith("/daemon/")) {
        // A paired daemon, not a browser tab, is the only caller here, so
        // there is no CORS story to defend against — but the guard costs
        // nothing to keep, and it refuses a body that was not sent as JSON
        // before a route below can misread it as one.
        if (req.method !== "POST") return sendJson(res, 405, { error: "daemon calls are POST" });
        if (!(req.headers["content-type"] ?? "").includes("application/json"))
          return sendJson(res, 415, { error: "daemon calls are application/json" });
        const raw = await readBody(req);
        if (raw === "too-large") return sendJson(res, 413, { error: "that request is too large" });
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          return sendJson(res, 400, { error: "that request body is not JSON" });
        }
        // Nobody is signed in on this surface — a daemon authenticates with
        // a machine token, never a session cookie — so a change one of
        // these routes records is attributed explicitly, the same way the
        // auth routes attribute a change to the member who was just made.
        const daemonChanges = changeRecorder({ store, actorId: null, now, channel });
        try {
          const result = handleDaemonRoute({
            store, changes: daemonChanges, method: req.method, path, body,
            authorization: req.headers.authorization, now: now(),
          });
          if (result) return sendJson(res, result.status, result.json);
          return sendJson(res, 404, { error: "no such route" });
        } finally {
          daemonChanges.flush();
        }
      }

      if (path.startsWith("/rpc/")) {
        if (req.method !== "POST") return sendJson(res, 405, { error: "rpc calls are POST" });
        if (!(req.headers["content-type"] ?? "").includes("application/json"))
          return sendJson(res, 415, { error: "rpc calls are application/json" });

        const actor = resolveActor(store, readCookie(req.headers.cookie, SESSION_COOKIE), now());
        if (!actor) return sendJson(res, 401, { error: "not signed in" });

        const raw = await readBody(req);
        if (raw === "too-large") return sendJson(res, 413, { error: "that request is too large" });
        let args: unknown;
        try {
          args = (JSON.parse(raw) as { args?: unknown }).args;
        } catch {
          return sendJson(res, 400, { error: "that request body is not JSON" });
        }

        // One recorder for the whole call, carried on the deps every family
        // module is handed, so whatever any of them records is in the queue
        // the `flush` below drains.
        const changes = changeRecorder({ store, actorId: actor.userId, now, channel });
        const api = createWorkspaceApi({ store, actor, now, config, channel, changes });
        const method = path.slice("/rpc/".length);
        if (!rpcMethods(api).has(method)) return sendJson(res, 404, { error: `no such method: ${method}` });
        try {
          return sendJson(res, 200, await dispatch(api, method, args as unknown[]));
        } catch (err) {
          // Dispatch raises a typed error for what a caller got wrong. Turning
          // that into a 500 would tell a client its own mistake was the
          // server falling over, and log a stack for every malformed request.
          if (isLykeionError(err))
            return sendJson(res, 200, {
              ok: false,
              error: { code: err.code, message: err.message },
            });
          console.error(`[rpc] ${method} failed`, err);
          return sendJson(res, 500, { error: "the workspace server failed to handle that call" });
        } finally {
          // Every write that got this far already committed or rolled back
          // inside `dispatch` — a write that succeeded before a later one in
          // the same call failed has still happened, and `flush` tells
          // committed and rolled-back apart on its own, so this runs
          // unconditionally on both paths.
          changes.flush();
        }
      }

      if (path === "/events") {
        // Only a GET opens a stream. Anything else would hang, holding a
        // connection open for a caller that is not going to read it.
        if (req.method !== "GET") return sendJson(res, 405, { error: "the event stream is read with GET" });
        const actor = resolveActor(store, readCookie(req.headers.cookie, SESSION_COOKIE), now());
        if (!actor) return sendJson(res, 401, { error: "not signed in" });

        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        // Node holds the header block back and sends it with the first
        // body write, to batch small writes — exactly wrong for a stream
        // that may have nothing to replay. Without this, a subscriber who
        // connects to an otherwise quiet workspace sees no response at all,
        // not even that the connection opened, until the first heartbeat or
        // change gives Node a body write to piggyback the headers on.
        res.flushHeaders();

        // `Last-Event-ID` is what the browser resends on its own reconnect;
        // the query parameter is for a first connection that already knows
        // where it left off.
        const header = req.headers["last-event-id"];
        // An empty header is not a cursor of zero, for the same reason an
        // absent query parameter is not: `Number("")` is `0`.
        const fromHeader = typeof header === "string" && header !== "" ? Number(header) : NaN;
        const rawQuery = url.searchParams.get("cursor");
        // `Number(null)` is `0`, not `NaN` — an absent parameter must not
        // read as cursor 0, or a client's very first connection replays the
        // whole retained log (or an empty log's `seq > 0`, which happens to
        // read as "nothing", masking the bug until the log is non-empty)
        // instead of subscribing fresh the way "no cursor" is supposed to.
        const fromQuery = rawQuery === null ? NaN : Number(rawQuery);
        const cursor = Number.isInteger(fromHeader)
          ? fromHeader
          : Number.isInteger(fromQuery)
            ? fromQuery
            : undefined;

        // Declared before `channel.subscribe` runs, because a cursor's
        // replay calls `send` synchronously — before `subscribe` has
        // returned an unsubscribe function for `end` to close over.
        let unsubscribe: () => void = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const end = () => {
          // Idempotent: `req.on("close")`, a failed write, and the server
          // shutting down can each arrive, in any order.
          if (!openStreams.has(end)) return;
          openStreams.delete(end);
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          if (!res.writableEnded) res.end();
        };

        // A write after the socket is gone throws. Guarding `writableEnded`
        // catches the ordinary case; the `try/catch` is for the socket
        // dying in the gap before that flag is set.
        const send = (message: Send) => {
          if (res.writableEnded) return;
          try {
            if (message.type === "resync") {
              res.write(`event: resync\ndata: {}\n\n`);
            } else {
              res.write(
                `id: ${message.message.seq}\nevent: change\ndata: ${JSON.stringify(message.message)}\n\n`,
              );
            }
          } catch {
            end();
          }
        };

        // Registered before the replay rather than after it, so a write that
        // fails part-way through tears down through `end` like every other
        // failure instead of finding itself absent from `openStreams` and
        // returning without doing anything.
        openStreams.add(end);
        req.on("close", end);

        unsubscribe = channel.subscribe(cursor, send, {
          userId: actor.userId,
          disconnect: end,
        });
        if (res.writableEnded) return end();

        // Proxies close a stream that says nothing. A comment line is not an
        // event, so the client never sees it. `unref`'d so a stream nobody
        // closes cannot keep the process alive on its own, and `res.write`
        // is guarded the same way the subscriber callback is.
        heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try {
            res.write(`: ping\n\n`);
          } catch {
            end();
          }
        }, 25_000);
        heartbeat.unref();
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD")
        return sendJson(res, 405, { error: "only GET is served here" });

      // The document is only ever served from the stamped shell. Reading
      // index.html off disk instead would hand back the unstamped file, and
      // a browser that cannot find the marker builds the in-browser demo —
      // so a researcher on their own lab's address would be shown fabricated
      // data and lose everything they wrote on the next reload.
      const relative = normalize(path);
      const isDocument = relative === "/" || relative === "/index.html";
      const file = join(config.uiDir, relative);
      // `join` cannot climb out of `uiDir` once the URL parser has collapsed
      // the path, but the separator keeps a sibling directory whose name
      // merely starts the same — `/srv/ui-private` against `/srv/ui` — from
      // satisfying a prefix test.
      const within = file === config.uiDir || file.startsWith(config.uiDir + sep);
      if (!isDocument && within) {
        try {
          const bytes = readFileSync(file);
          res.writeHead(200, {
            "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
            "x-content-type-options": "nosniff",
          });
          return res.end(bytes);
        } catch {
          // An address with a file extension was asking for an asset, and
          // there is no such asset. Answering with the shell would send HTML
          // under a script's content type and surface as a blank page.
          if (extname(relative) !== "")
            return sendJson(res, 404, { error: `no such file: ${relative}` });
        }
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexHtml);
    })().catch((err: unknown) => {
      console.error("[http] unhandled", err);
      if (!res.headersSent) sendJson(res, 500, { error: "the workspace server failed" });
    });
  };
}
