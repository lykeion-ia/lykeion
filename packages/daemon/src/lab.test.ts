import { afterEach, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { backoffDelayMs, heartbeat, LabRefused, report } from "./lab";

interface RecordedRequest {
  method: string | undefined;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

const labs: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
});

/**
 * A real HTTP server standing in for the lab: every request it receives is
 * recorded exactly as it arrived, and `answer` decides what it says back.
 */
async function stubLab(
  answer: (req: RecordedRequest) => {
    status: number;
    body?: unknown;
    /** Set to answer as something that is not the lab — a sign-in portal in
     *  front of it serves HTML, and that is the whole difference. */
    contentType?: string;
    rawBody?: string;
  },
): Promise<{ base: string; requests: RecordedRequest[]; close(): Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method,
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(recorded);
      const { status, body, contentType, rawBody } = answer(recorded);
      res.writeHead(status, { "content-type": contentType ?? "application/json" });
      if (rawBody !== undefined) res.end(rawBody);
      else res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const handle = {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  labs.push(handle);
  return handle;
}

it("report posts what it found, with a bearer token and a JSON content-type", async () => {
  const lab = await stubLab(() => ({ status: 200, body: { ok: true } }));
  const body = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [
      { id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true, sessionReady: true },
    ],
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    cores: 8,
    kernels: { ready: true },
    processVisibility: "macOS reports memory and processor use for a process Lykeion started itself.",
  };

  await report(lab.base, "a-token", body);

  expect(lab.requests).toHaveLength(1);
  const [request] = lab.requests;
  expect(request!.method).toBe("POST");
  expect(request!.path).toBe("/daemon/report");
  expect(request!.headers.authorization).toBe("Bearer a-token");
  expect(request!.headers["content-type"]).toContain("application/json");
  expect(request!.body).toEqual(body);
});

it("heartbeat posts an empty body, with the same authorization", async () => {
  const lab = await stubLab(() => ({ status: 200, body: { ok: true } }));

  await heartbeat(lab.base, "a-token");

  expect(lab.requests).toHaveLength(1);
  const [request] = lab.requests;
  expect(request!.method).toBe("POST");
  expect(request!.path).toBe("/daemon/heartbeat");
  expect(request!.headers.authorization).toBe("Bearer a-token");
  expect(request!.headers["content-type"]).toContain("application/json");
  expect(request!.body).toEqual({});
});

it("throws LabRefused on a 401, from either call", async () => {
  const lab = await stubLab(() => ({ status: 401, body: { error: "no such machine" } }));
  await expect(heartbeat(lab.base, "a-token")).rejects.toBeInstanceOf(LabRefused);

  const lab2 = await stubLab(() => ({ status: 401, body: { error: "no such machine" } }));
  await expect(
    report(lab2.base, "a-token", {
      platform: "",
      daemonVersion: "",
      capabilities: [],
      clis: [],
      totalMemoryBytes: 0,
      cores: 0,
      kernels: { ready: false, reason: "uv is not installed, and Lykeion starts kernels with it" },
      processVisibility: "This platform has not been checked for process visibility.",
    }),
  ).rejects.toBeInstanceOf(LabRefused);
});

it("does not read a sign-in page in front of the lab as the lab dismissing this machine", async () => {
  // An SSO portal or a reverse proxy answers 401 with a page for a person to
  // look at. It knows nothing about whether this lab still has this machine,
  // and treating it as a dismissal sets aside a working token over somebody
  // else's outage — after which the daemon cannot come back on its own.
  const portal = await stubLab(() => ({
    status: 401,
    contentType: "text/html; charset=utf-8",
    rawBody: "<html><body>Please sign in to continue</body></html>",
  }));
  await expect(heartbeat(portal.base, "a-token")).rejects.not.toBeInstanceOf(LabRefused);
  await expect(heartbeat(portal.base, "a-token")).rejects.toThrow(/asking for a sign-in/);

  // A 401 that claims to be JSON but carries no error the lab wrote is the
  // same situation wearing the right header.
  const bare = await stubLab(() => ({ status: 401, body: { message: "unauthorized" } }));
  await expect(heartbeat(bare.base, "a-token")).rejects.not.toBeInstanceOf(LabRefused);
});

it("prefers the lab's own error message over an invented one, for a non-401 failure", async () => {
  const lab = await stubLab(() => ({ status: 500, body: { error: "the lab is out of disk" } }));
  await expect(heartbeat(lab.base, "a-token")).rejects.toThrow("the lab is out of disk");
});

it("is not LabRefused when the lab answers with a status other than 401", async () => {
  const lab = await stubLab(() => ({ status: 500, body: { error: "the lab is out of disk" } }));
  await expect(heartbeat(lab.base, "a-token")).rejects.not.toBeInstanceOf(LabRefused);
});

it("names the lab when it cannot be reached at all", async () => {
  // Nothing is listening on this port — the connection itself fails, before
  // any status code exists to inspect.
  await expect(heartbeat("http://127.0.0.1:1", "a-token")).rejects.toThrow(/127\.0\.0\.1:1/);
});

it("falls back to a generic message naming the status, when the failure body will not parse", async () => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("not json at all");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  labs.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });

  await expect(heartbeat(base, "a-token")).rejects.toThrow(/status 500/);
});

it("backoffDelayMs doubles the wait with every failed attempt", () => {
  expect(backoffDelayMs(1)).toBe(1000);
  expect(backoffDelayMs(2)).toBe(2000);
  expect(backoffDelayMs(3)).toBe(4000);
  expect(backoffDelayMs(4)).toBe(8000);
});

it("backoffDelayMs caps the wait at its ceiling rather than growing without bound", () => {
  expect(backoffDelayMs(10)).toBe(30_000);
  expect(backoffDelayMs(100)).toBe(30_000);
});
