import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startKernelHost, type KernelHost } from "./kernel-host";
import { freshDir } from "./test-support/fresh-dir";

const STUB_HOST = join(import.meta.dirname, "test-support", "stub-kernel-host.ts");
const open: KernelHost[] = [];

afterEach(async () => {
  for (const host of open.splice(0)) await host.stop();
});

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** How long the daemon's own end of a pipe the child just destroyed takes
 *  to learn it: an OS notification neither side can observe completing,
 *  so a call issued too soon after can still be written successfully into
 *  a pipe nothing will ever read from again — this is long enough that it
 *  reliably has landed first. */
const PIPE_CLOSE_SETTLE_MS = 200;

/** A host speaking to `stub-kernel-host.ts`, tracked so a test that ends
 *  before reaching its own stop() — on a failure, or on a bug in stop()
 *  itself — does not leave a real process behind on whatever machine ran
 *  the suite. */
function stub(...args: string[]): KernelHost {
  const host = startKernelHost({
    command: process.execPath,
    args: ["--experimental-strip-types", STUB_HOST, ...args],
  });
  open.push(host);
  return host;
}

it("asks the host what it is, and gets an answer", async () => {
  const host = stub();
  await expect(host.call("host.hello", {})).resolves.toEqual({
    protocol: 2,
    languages: [{ language: "python", environment: "python", reads: [] }],
  });
  await host.stop();
});

it("settles every outstanding call when the host dies", async () => {
  const host = stub("--die-on", "host.hello");
  // A promise nothing settles is a machine that looks hung. A host that
  // exits mid-call fails that call, saying so.
  await expect(host.call("host.hello", {})).rejects.toThrow(/kernel host exited/i);
  await host.stop();
});

it("delivers a notification to whoever is listening for it", async () => {
  const host = stub("--announce", "cell");
  const cells: unknown[] = [];
  host.on("cell", (params) => cells.push(params));
  await host.call("host.hello", {});
  await waitFor(() => expect(cells).toHaveLength(1));
  await host.stop();
});

it("is not running once it has been stopped", async () => {
  const host = stub();
  await host.call("host.hello", {});
  await host.stop();
  expect(host.running).toBe(false);
});

it("reassembles a reply whose bytes arrive split across two chunks", async () => {
  const host = stub("--split-hello");
  await expect(host.call("host.hello", {})).resolves.toEqual({
    protocol: 2,
    languages: [{ language: "python", environment: "python", reads: [] }],
  });
  await host.stop();
});

it("rejects a call the host answered with an error rather than a result", async () => {
  const host = stub();
  await expect(host.call("host.nonsense", {})).rejects.toThrow(/no method named host\.nonsense/i);
  await host.stop();
});

it("rejects a call made after stop() rather than writing into a stream that is ending", async () => {
  const host = stub();
  await host.call("host.hello", {});
  // stop() ends stdin synchronously before this line returns; alive stays
  // true until exit lands, a whole event-loop turn later, so a call landing
  // in this exact gap is the one this guards.
  const stopping = host.stop();
  await expect(host.call("host.hello", {})).rejects.toThrow(/stopping/i);
  await stopping;
});

it("does not crash the process when the host's own end of the pipe is gone", async () => {
  const host = stub("--close-stdin-on", "host.hello");
  await host.call("host.hello", {});
  // The stub answered and then destroyed its own stdin without exiting, so
  // this write lands on a pipe with nobody left to read it.
  await new Promise((resolve) => setTimeout(resolve, PIPE_CLOSE_SETTLE_MS));
  await expect(host.call("host.hello", {})).rejects.toThrow(/kernel host exited/i);
  await host.stop();
});

it("still kills the process once a write failure has already marked it dead", async () => {
  const marker = join(freshDir(), "exit-marker");
  const host = startKernelHost({
    command: process.execPath,
    args: ["--experimental-strip-types", STUB_HOST, "--close-stdin-on", "host.hello"],
    env: { ...process.env, LYKEION_STUB_EXIT_MARKER: marker },
  });
  open.push(host);
  await host.call("host.hello", {});
  await new Promise((resolve) => setTimeout(resolve, PIPE_CLOSE_SETTLE_MS));
  // The write failure above already ran die(): running is false and every
  // further call rejects on the spot. That is not proof the process is
  // gone — only the exit marker the stub writes on SIGTERM is.
  await expect(host.call("host.hello", {})).rejects.toThrow(/kernel host exited/i);
  expect(host.running).toBe(false);
  await host.stop();
  expect(existsSync(marker)).toBe(true);
});

it("resolves stop() even when the host never started at all", async () => {
  const host = startKernelHost({ command: "this-command-does-not-exist-lykeion-test", args: [] });
  open.push(host);
  // A spawn that never started emits error, then close — never exit — so a
  // stop() that only waited on exit would wait for an event not coming.
  await host.stop();
  expect(host.running).toBe(false);
});

/**
 * The second direction. Everything above is this daemon asking the host for
 * something; these are the host asking THIS process for something only it
 * can do — the researcher's live session and the lab's own token are here
 * and not there.
 *
 * Driven against the real child process, both ways: the ask is written by
 * the stub onto its own stdout, the reply is written by `startKernelHost`
 * onto the child's stdin, and what is asserted is the object the STUB read
 * back, announced from there. Neither end can pass this by agreeing with
 * itself.
 */
it("serves what the host asks it for, and the answer reaches the host", async () => {
  const host = stub("--ask", "environment.create");
  const answers: unknown[] = [];
  host.on("answered", (params) => answers.push(params));
  host.serve("environment.create", async (params) => ({ echoed: params }));
  await host.call("host.hello", {});
  await waitFor(() => expect(answers).toHaveLength(1));
  // Under the host's OWN id, which this daemon never minted and never
  // matches its own replies against.
  expect(answers[0]).toEqual({ id: 1, result: { echoed: { what: "this" } } });
  await host.stop();
});

it("answers an ask it serves nothing for rather than dropping it", async () => {
  // A host waiting on a reply that never comes is indistinguishable from a
  // machine that has stopped answering — and the tool call behind it is a
  // researcher watching nothing happen. The same rule the host applies to a
  // method IT does not know.
  const host = stub("--ask", "nothing.here");
  const answers: unknown[] = [];
  host.on("answered", (params) => answers.push(params));
  await host.call("host.hello", {});
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers[0]).toEqual({
    id: 1,
    error: { message: "this machine's daemon serves no method named nothing.here" },
  });
  await host.stop();
});

it("turns a handler that throws where it stands into an error reply", async () => {
  // A handler that throws synchronously never produces a promise to reject,
  // so nothing downstream of an unwrapped call would catch it — the throw
  // would leave the data handler instead, taking the host's reply with it.
  const host = stub("--ask", "environment.create");
  const answers: unknown[] = [];
  host.on("answered", (params) => answers.push(params));
  host.serve("environment.create", () => {
    throw new Error("this machine will not");
  });
  await host.call("host.hello", {});
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers[0]).toEqual({ id: 1, error: { message: "this machine will not" } });
  await host.stop();
});

it("does not mistake the host's own ask for the answer to a call of its own", async () => {
  // The ask below carries id 1, and so does this daemon's first call. Read
  // as a reply, it would settle `host.hello` with the ask's own params —
  // resolving a call with something nobody answered — and the handler that
  // was meant to serve it would never run at all.
  const host = stub("--ask", "environment.create");
  const answers: unknown[] = [];
  host.on("answered", (params) => answers.push(params));
  host.serve("environment.create", async () => ({ served: true }));
  const hello = await host.call("host.hello", {});
  expect(hello).toMatchObject({ protocol: 2 });
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers[0]).toEqual({ id: 1, result: { served: true } });
  await host.stop();
});

it("drops a line that is neither an answer, an ask, nor an announcement", async () => {
  // `{id: 1}` alone is none of the three. Answered as an ask it would put
  // `no method named undefined` back under id 1 — a number in the HOST's own
  // ask space, which the very next ask here is genuinely waiting on. Dropped,
  // the worst case is a wait, and a wait is what the host's own `settle_all`
  // already ends.
  const host = stub("--ask", "environment.create", "--malformed-first");
  const answers: Array<{ id?: number }> = [];
  host.on("answered", (params) => answers.push(params as { id?: number }));
  host.serve("environment.create", async () => ({ served: true }));
  await host.call("host.hello", {});
  await waitFor(() => expect(answers).toHaveLength(1));
  // Long enough for a second reply to have arrived if one were coming.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(answers).toEqual([{ id: 2, result: { served: true } }]);
  await host.stop();
});
