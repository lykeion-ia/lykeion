import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import { connectAcp, type AcpConnection } from "./acp";

const STUB = join(import.meta.dirname, "test-support", "stub-acp-agent.ts");
const open: AcpConnection[] = [];

afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function stub(script: unknown[]): Promise<AcpConnection> {
  const c = await connectAcp(process.execPath, ["--experimental-strip-types", STUB], {
    env: { ...process.env, LYKEION_STUB_SCRIPT: JSON.stringify(script) },
  });
  open.push(c);
  return c;
}

it("completes a request and returns the agent's result", async () => {
  const c = await stub([]);
  const result = (await c.request("initialize", { protocolVersion: 1 })) as {
    protocolVersion: number;
  };
  expect(result.protocolVersion).toBe(1);
});

it("delivers a notification the agent sent while a prompt was running", async () => {
  const c = await stub([{ emit: "agent_message_chunk", text: "hello" }]);
  await c.request("initialize", { protocolVersion: 1 });
  await c.request("session/new", { cwd: "/tmp" });
  const seen: unknown[] = [];
  c.onNotify("session/update", (p) => seen.push(p));
  await c.request("session/prompt", { sessionId: "stub-session", prompt: [] });
  expect(seen).toHaveLength(1);
});

it("answers a request the agent makes of the client", async () => {
  const c = await stub([{ ask: "permission", toolCallId: "t1", title: "Write foo" }]);
  await c.request("initialize", { protocolVersion: 1 });
  await c.request("session/new", { cwd: "/tmp" });
  let asked = false;
  c.onRequest("session/request_permission", async () => {
    asked = true;
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });
  await c.request("session/prompt", { sessionId: "stub-session", prompt: [] });
  // The agent blocks on this request, so a prompt that returned at all is
  // proof the answer got back to it — not merely that a handler ran.
  expect(asked).toBe(true);
});

it("surfaces an error the agent answered with, rather than hanging", async () => {
  const c = await stub([]);
  await expect(c.request("session/frobnicate", {})).rejects.toThrow(/no such method/);
});

it("keeps the tail of what the adapter wrote to stderr", async () => {
  const c = await connectAcp(process.execPath, ["-e", "process.stderr.write('boom\\n'); setTimeout(()=>{},500)"]);
  open.push(c);
  await new Promise((r) => setTimeout(r, 200));
  expect(c.stderrTail()).toContain("boom");
});

it("rejects a request made after the adapter exited with nothing pending on it", async () => {
  const c = await connectAcp(process.execPath, ["-e", "process.exit(0)"]);
  open.push(c);
  await new Promise((r) => setTimeout(r, 300));
  await expect(c.request("initialize", {})).rejects.toThrow(/exited/);
});

it("rejects rather than throwing when a request races a close on a still-alive adapter", async () => {
  const c = await stub([]);
  const closing = c.close();
  await expect(c.request("initialize", { protocolVersion: 1 })).rejects.toThrow(/closed/);
  await closing;
});

it("treats a stdout line that never ends as an adapter fault instead of growing without bound", async () => {
  const c = await connectAcp(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(2_000_000)); setTimeout(() => {}, 2000)",
  ]);
  open.push(c);
  await new Promise((r) => setTimeout(r, 300));
  await expect(c.request("initialize", {})).rejects.toThrow(/line/);
});

it("kills an adapter that ignores SIGTERM so close does not hang", async () => {
  const c = await connectAcp(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  ]);
  open.push(c);
  // Gives the child time to actually install its SIGTERM handler before
  // close() sends one — otherwise the signal can arrive while Node is still
  // starting up, land on the default handler instead, and end the process
  // for a reason this test is not trying to exercise.
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  await c.close();
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(900);
  expect(elapsed).toBeLessThan(4000);
});
