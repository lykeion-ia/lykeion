/**
 * Test support: a fresh workspace server, reachable the way a browser
 * reaches it — HTTP, cookies, JSON RPC envelopes — with an owner already
 * signed in. `conformance.test.ts` and `ordering.test.ts` both build their
 * `LykeionApi` this way rather than calling `createWorkspaceApi` directly,
 * so what they hold to is the wire contract a real client sees, not an
 * in-process shortcut around it.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpApi, LykeionError, type LykeionApi } from "@lykeion/api";
import { readConfig, type ServerConfig } from "../config";
import { startServer } from "../http";

export interface TestServer {
  base: string;
  close(): Promise<void>;
}

/**
 * A fresh server on port 0, backed by a temporary data directory that is
 * removed on `close`. Every caller in this file — the single-owner harness
 * below and the multi-person one in `test-lab.ts` — starts from here, so
 * "how a test server comes up" has exactly one answer.
 */
export async function startTestServer(
  overrides: Partial<ServerConfig> = {},
  now?: () => number,
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-test-"));
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><head></head><body></body>");

  // `overrides` sits between the defaults and the four fields this function
  // owns, not after them: `dataDir` and `uiDir` name the directories `close`
  // deletes, and a caller free to move them would leave a real directory
  // emptied and this temporary one leaked.
  const server = await startServer(
    { ...readConfig({}), ...overrides, host: "127.0.0.1", port: 0, dataDir: dir, uiDir },
    now,
  );
  const base = `http://127.0.0.1:${server.port}`;

  return {
    base,
    async close() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A `LykeionApi` that carries one cookie on every call, the way a signed-in
 * browser tab does. There is no browser here to hold the cookie jar, so it
 * is threaded through explicitly instead.
 *
 * A 401 becomes a `LykeionError("unauthenticated", ...)` rather than the
 * plain rejection a bad status would otherwise produce: it is the one
 * status the RPC route returns before `dispatch` ever runs, so it never
 * reaches the `{ ok, value, error }` envelope every other outcome answers
 * with, and a caller testing for `isLykeionError` needs it translated the
 * same way the browser's own transport already does.
 */
export function apiFor(base: string, cookie: string): LykeionApi {
  return createHttpApi({
    async request(method, args) {
      const res = await fetch(`${base}/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ args }),
      });
      if (res.status === 401) {
        const body = (await res.json()) as { error?: string };
        throw new LykeionError("unauthenticated", body.error ?? "not signed in");
      }
      if (!res.ok) throw new Error(`${method} answered ${res.status}`);
      const body = (await res.json()) as {
        ok: boolean;
        value?: unknown;
        error?: { code: string; message: string };
      };
      if (body.ok) return body.value;
      throw new LykeionError(
        body.error!.code as ConstructorParameters<typeof LykeionError>[0],
        body.error!.message,
      );
    },
    openEvents: () => () => {},
    openRun: () => () => {},
  });
}

export async function signUpOwner(base: string): Promise<string> {
  const setup = await fetch(`${base}/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "owner@lab.example",
      displayName: "Owner",
      password: "a good long password",
    }),
  });
  return setup.headers.get("set-cookie")!.split(";")[0];
}

export interface ServerApiHandle {
  api: LykeionApi;
  close(): Promise<void>;
}

/**
 * A fresh, isolated workspace with an owner signed into it. The suite
 * requires both: instances must not share state, and the caller must be an
 * owner, because the membership tests exercise owner-only methods.
 *
 * `now`, when given, replaces the server's clock — the way a test proves an
 * ordering tiebreak does real work rather than happening to pass because a
 * real clock rarely repeats a second between two writes.
 */
export async function makeServerApi(now?: () => number): Promise<ServerApiHandle> {
  const server = await startTestServer({}, now);
  const cookie = await signUpOwner(server.base);
  return { api: apiFor(server.base, cookie), close: server.close };
}
