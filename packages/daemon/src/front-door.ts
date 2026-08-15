import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FORWARDED_PREFIXES } from "@lykeion/api/routes";

/**
 * The built UI, found relative to this module rather than to the working
 * directory. A path built from `process.cwd()` resolves differently depending
 * on where the operator happened to run the command from, and the failure is
 * an ENOENT that names a directory nobody meant. This holds whether the
 * daemon is running from source under vitest or from its own bundle, because
 * both sit exactly two directories above `packages/ui/dist`.
 */
export function uiDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

/**
 * The one spelling of the path a request names: query and fragment gone,
 * percent-escapes decoded, a trailing slash collapsed.
 *
 * Exported because `pairing.ts` has to decide whether a request names one of
 * the routes it owns before offering it to this door, and that decision has
 * to agree with the route table it is standing in front of. The route table
 * matches on `new URL(...).pathname`, which collapses dot segments and leaves
 * percent-escapes alone — so `/x/../paired` and `//elsewhere/paired` reach it
 * already reading as `/paired`, while `/%70aired` does not, though per RFC
 * 3986 §6.2.2.2 it names the same URI. Applied to that pathname, this
 * finishes what the parser started, and the guard then sees every spelling
 * the route table sees and two it does not.
 *
 * This door asks twice, because it is asking two different things. Whether a
 * path belongs to the lab rather than to the page is a route question, and
 * gets the collapsed pathname for the same reason the guard above does: the
 * lab will collapse it too, so `/x/../runs/abc/events` is the stream
 * `/runs/abc/events` names. Which file a path names is not a route question —
 * dot segments are part of the answer to it, and the raw target goes on to
 * `resolve` and to the boundary check that refuses the paths leading out of
 * the directory. One rule for the whole function would get one of the two
 * wrong, and each has already been wrong once.
 *
 * `undefined` for a target that is not a valid encoding at all. There is
 * nothing to be said about what path it names, and guessing at what was meant
 * is how a traversal check gets walked around.
 */
export function requestPath(target: string | undefined): string | undefined {
  const named = (target ?? "/").split(/[?#]/, 1)[0]!;
  let path: string;
  try {
    path = decodeURIComponent(named);
  } catch {
    return undefined;
  }
  // `/paired/` names what `/paired` names. The root is left alone, being
  // nothing but its own trailing slash.
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/**
 * The path a request names as every route table that will read it does: dot
 * segments collapsed, which is what `new URL` does on its way to a pathname
 * and what `pairing.ts` matches its own routes on.
 *
 * The base is arbitrary and thrown away — only the path is read. `undefined`
 * for a target no URL parser will take at all, which leaves the caller with
 * the target's own reading and no worse off than before this existed.
 */
function routedPath(target: string | undefined): string | undefined {
  try {
    return requestPath(new URL(target ?? "/", "http://127.0.0.1").pathname);
  } catch {
    return undefined;
  }
}

/**
 * What each extension the built UI actually emits is, and nothing else. The
 * fallback below is `application/octet-stream` rather than a guess: a browser
 * handed the wrong type for something it can execute is a worse outcome than
 * one handed a download it did not want, and a build that starts emitting a
 * kind of file not listed here is a change somebody should have to make on
 * purpose.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/**
 * Whether this request target names something the lab answers rather than
 * the daemon. Exported because two decisions turn on it and they have to
 * agree exactly: the page fallback below must not swallow an API route, and
 * the server in front of it must hand that same route to the lab. Two
 * copies of this question would eventually answer it differently, and the
 * shape of that bug is a route that is neither served nor forwarded.
 *
 * Asked of the collapsed path and not of the file path, because this is a
 * route question and not a file question: every route table that will read
 * this request — the daemon's own, and the lab's once it is forwarded there
 * — collapses the dot segments first, so `/x/../runs/abc/events` is the
 * stream `/runs/abc/events` names. Read from the register in `@lykeion/api`
 * rather than a copy, because the copy is what drifts.
 */
export function isForwarded(target: string | undefined): boolean {
  const routed = routedPath(target) ?? requestPath(target);
  if (routed === undefined) return false;
  return FORWARDED_PREFIXES.some(
    ({ prefix }) => routed === prefix || routed.startsWith(`${prefix}/`),
  );
}

/**
 * Serves the built single-page application: the asset if the path names one,
 * and `index.html` if it does not, so that a deep link typed into the address
 * bar reaches a router that only exists once the page has loaded.
 *
 * Returns whether it answered, so the caller can go on refusing what it was
 * going to refuse. It is deliberately the last thing tried and the widest:
 * everything it does not hand back belongs to a route, and a route that does
 * not exist should say so rather than hand back a page.
 *
 * `step`, when given, marks the page with the step of the setup wizard it
 * must open on. See `markSetupStep` for why it is a substitution.
 */
export function serveApp(
  req: IncomingMessage,
  res: ServerResponse,
  uiDir: string,
  step?: number,
  /** Whether a lab is actually reachable through this origin. See
   *  `markWorkspace` — the page runs as an in-browser demo without it. */
  workspace = false,
): boolean {
  // Only a GET asks for a page. Anything else arriving at a path with no
  // route behind it is a call on something that does not exist, and the 404
  // this door stands in front of is the answer to it — a 200 carrying the
  // application would tell whoever sent it that their POST was taken.
  if (req.method !== "GET") return false;

  // What file this request names, which is a question the dot segments are
  // part of the answer to — they go on to `resolve` and the boundary below.
  const named = requestPath(req.url);
  if (named === undefined) {
    // `%zz` and friends. Answered rather than passed on, because the routes
    // behind this door were offered the same undecodable target and made
    // nothing of it either.
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("that path is not a valid request target");
    return true;
  }

  // The check that keeps the fallback from swallowing an API route. Without
  // it every unmatched path under a forwarded prefix would be answered with
  // `index.html` and a 200 — which is how `/runs/:id/events` once handed an
  // EventSource an HTML body it refused, leaving a run that started and
  // persisted correctly rendering nothing at all. See {@link isForwarded}
  // for why that question is asked of the collapsed path.
  if (isForwarded(req.url)) return false;

  // Traversal is refused on the resolved path, never on the text of the
  // request: `..` can arrive percent-encoded, doubled up, or folded into a
  // segment that only means what it means once the whole path is normalised.
  // Comparing after `resolve` asks the question that actually matters — is
  // the file this names inside the directory we serve — and cannot be
  // spelled around.
  //
  // Both sides go through their symlinks first, because `statSync` and
  // `createReadStream` follow links and a lexical comparison does not: a link
  // inside the built UI pointing anywhere else would name a path under the
  // root and open a file that is not. Vite emits no links and there are none
  // there today, so this is defence in depth — and it is free, which is the
  // wrong thing to be arguing about in a security boundary.
  const root = realPath(resolve(uiDir));
  const file = realPath(named.startsWith("/") ? resolve(root, `.${named}`) : resolve(root, named));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("that path is outside the application");
    return true;
  }

  if (isFile(file)) return sendFile(res, file, step, workspace);
  // Anything else — a path with no file behind it, or a directory — is a
  // route inside the application, which only its own router can resolve.
  const index = resolve(root, "index.html");
  if (isFile(index)) return sendFile(res, index, step, workspace);

  // Said plainly rather than as "no such route", because there is only one
  // way to arrive here: the daemon is running against a tree whose UI was
  // never built, and every path it serves will fail the same way until it is.
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("the application has not been built");
  return true;
}

/**
 * The path with every symlink along it resolved, or the path itself when
 * there is nothing at it. Most of what this door is asked for is a route
 * inside the application rather than a file, and a route has no real path —
 * the lexical one is what the boundary then compares, which is exactly as
 * safe, because a file that is not there is a file that cannot be served.
 */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The application's own page as a string, marked with the step it should
 * open on, or `undefined` when this daemon has no built UI to serve.
 *
 * For the one caller that cannot simply hand a request to `serveApp`: coming
 * back from a remote lab, `/paired` has a pairing to settle in the same
 * response it answers with, and settling is what stops the request timer. So
 * that route needs the page as a value it can pass to the function that
 * settles, rather than a function that writes the response out from under it.
 *
 * Both paths mark the page the same way, through `markSetupStep`, so the two
 * ways of arriving at a step cannot disagree about how a step is named.
 */
export function appPage(
  uiDir: string,
  step?: number,
  options?: { workspace?: boolean },
): string | undefined {
  const file = join(uiDir, "index.html");
  try {
    let html = readFileSync(file, "utf8");
    if (step !== undefined) html = markSetupStep(html, step);
    if (options?.workspace === true) html = markWorkspace(html);
    return html;
  } catch {
    return undefined;
  }
}

function sendFile(
  res: ServerResponse,
  file: string,
  step: number | undefined,
  workspace: boolean,
): boolean {
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

  if ((step !== undefined || workspace) && type.startsWith("text/html")) {
    // Read whole, because the marks go in before the first byte goes out.
    // The page is a few kilobytes of shell; everything in it that is large is
    // an asset it asks for afterwards, and those take the stream below.
    let html = readFileSync(file, "utf8");
    if (step !== undefined) html = markSetupStep(html, step);
    if (workspace) html = markWorkspace(html);
    const marked = Buffer.from(html, "utf8");
    res.writeHead(200, { "content-type": type, "content-length": marked.byteLength });
    res.end(marked);
    return true;
  }

  // Streamed rather than read: the largest thing in the built UI is a syntax
  // highlighter's grammars, and holding one of those in memory for the length
  // of a request buys nothing.
  res.writeHead(200, { "content-type": type });
  const source = createReadStream(file);
  source.on("error", () => {
    // The file was there when it was stated and is not there now, or cannot
    // be read. The headers are already out, so the only thing left to say is
    // that the body is not coming.
    res.destroy();
  });
  source.pipe(res);
  return true;
}

/**
 * Puts `data-setup-step` on the page's `<html>` element.
 *
 * A substitution on built HTML, because the file being served is one Vite
 * already produced and this process cannot ask Vite to parameterise it, and
 * because `@lykeion/daemon` carries no runtime dependencies — there is no
 * parser here and adding one to write a single attribute is not a trade worth
 * making. The alternative was a query parameter, and a query parameter
 * survives into every navigation the application makes afterwards, so the
 * wizard's opening step would still be in the address bar long after it was
 * finished with.
 *
 * A build whose opening tag is not there is served unchanged rather than
 * refused: a daemon that will not serve its own page because the HTML changed
 * shape is worse than one that opens on step 1 and lets the researcher click.
 */
/**
 * Tells the page it is talking to a real lab, exactly as the workspace server
 * does when it serves the same file.
 *
 * The application decides between a real lab and its own in-browser demo by
 * looking for this meta tag, and the built file carries none — the server
 * injects it at serve time so nothing has to be built twice. A daemon serving
 * that same file has to make the same declaration or the page runs as a demo
 * on a machine with a working lab right behind it.
 *
 * Only when there IS one behind it. A daemon whose lab is on another computer
 * forwards none of the lab's routes through this origin, so a page that
 * declared a workspace here would call `/rpc` on a door that answers 404 —
 * worse than the demo, because the demo at least says what it is.
 */
function markWorkspace(html: string): string {
  if (html.includes("</head>")) return html.replace("</head>", `${WORKSPACE_MARKER}</head>`);
  // A build with no head. Unlike the step mark, leaving this off is not a
  // harmless no-op — the page would decide it has no lab and run its own
  // in-browser demo against a machine with a real one — so it goes in after
  // the opening tag rather than being dropped.
  const at = html.indexOf(">", html.indexOf("<html"));
  return at === -1 ? html : `${html.slice(0, at + 1)}${WORKSPACE_MARKER}${html.slice(at + 1)}`;
}

/** The same string `packages/server` injects. Two copies of one marker would
 *  drift, and the drift is invisible: the page simply runs as a demo. */
const WORKSPACE_MARKER = '<meta name="lykeion-workspace" content="1">';

function markSetupStep(html: string, step: number): string {
  const at = html.indexOf("<html");
  if (at === -1) return html;
  return `${html.slice(0, at + "<html".length)} data-setup-step="${step}"${html.slice(at + "<html".length)}`;
}

/**
 * Hands a request on to the lab running on this machine and hands its answer
 * back, so that one address serves the application and everything the
 * application calls.
 *
 * Piped in both directions rather than read and re-sent. `/events` and
 * `/runs/:id/events` are held open for as long as a tab is: a proxy that
 * collected the body before passing it on would deliver a live turn only once
 * the turn was over, which is indistinguishable from delivering nothing.
 */
export function forwardTo(port: number): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: req.method,
        path: req.url,
        // The lab is told the address it answers on, not the one the browser
        // typed. Nothing in the lab reads `Host` today, so nothing observable
        // turns on this; the choice is about what happens when something
        // does. A forwarded `Host` is a value the browser chose — under DNS
        // rebinding, a value an attacker chose — and passing it on would make
        // the daemon a courier for it, so any `Host` or `Origin` defence the
        // lab later grows would be defending against a header this hop
        // laundered. Rewriting it means the one thing the lab can read about
        // where a request came from is something the daemon vouches for. The
        // cost if this is reversed: absolute URLs the lab might one day build
        // from `Host` would point at the daemon, which is the address the
        // browser can reach — that is the case for forwarding, and it is not
        // worth the laundering.
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
      },
      (labRes) => {
        res.writeHead(labRes.statusCode ?? 502, labRes.headers);
        labRes.pipe(res);
        // `pipe` finishes the response when the lab's answer ends and does
        // nothing whatever when it is cut off partway, so an answer that
        // stops has to be carried across by hand. A lab restart — routine
        // while somebody is developing one — otherwise leaves every held-open
        // `/events` and `/runs/:id/events` response written to and never
        // finished, and a browser whose connection never closes is a browser
        // whose `EventSource` never fires `onerror` and so never reconnects:
        // the live turn that renders nothing, arriving from the far side.
        // Destroyed rather than ended, because a body that stopped halfway is
        // not a body that finished and must not be handed over as one.
        const cutOff = () => res.destroy();
        labRes.on("aborted", cutOff);
        labRes.on("error", cutOff);
      },
    );
    upstream.on("error", () => {
      // Nothing to say to a browser that has already gone.
      if (res.destroyed || res.writableEnded) return;
      // Once the headers are out there is no status left to send, and the
      // body below would be appended to whatever the lab had already
      // streamed — a JSON object arriving in the middle of a
      // `text/event-stream`, which is worse than silence.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the lab on this machine did not answer" }));
    });
    // A tab that closes an EventSource closes this response, and the request
    // to the lab has to go with it. Without this the lab keeps a stream open
    // for every tab that ever opened one, and nothing closes them.
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };
}
