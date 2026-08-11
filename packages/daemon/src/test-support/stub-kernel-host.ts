/**
 * A kernel host stub: speaks the same line-delimited JSON as the real one,
 * and does exactly what its arguments ask, so a daemon test can exercise
 * `startKernelHost` against a real child process without a Python
 * interpreter anywhere on the machine running it.
 *
 * `--die-on <method>` exits the moment a request naming that method
 * arrives, without answering it — the shape of a host that stops mid-call.
 * `--announce <method>` sends one notification naming that method as soon
 * as this process comes up. `--split-hello` answers `host.hello` in two
 * writes with a pause between them, so the reply's bytes cross two chunks
 * on the reading end. `--close-stdin-on <method>` answers a request naming
 * that method normally, then closes this process's own stdin — every way
 * available, so nothing keeps the daemon's own end of the pipe believing a
 * reader is still there — without exiting: the shape of a host whose pipe
 * has gone but is still running, with nothing left inside it to notice a
 * request ever arrives again. The daemon's own end of the pipe learns this
 * asynchronously, on its own clock, not the instant this runs.
 * Any request not named by `--die-on` is answered: `host.hello` with
 * `{protocol: 2, languages: [...]}`, anything else with an error, the same
 * split the real host draws between a known method and an unknown one.
 * `--languages <a,b>` names the descriptors `host.hello` reports, one per
 * language named, comma-separated and defaulting to `python` alone.
 *
 * `LYKEION_STUB_EXIT_MARKER`, when set, is appended to with this process's
 * pid the moment SIGTERM arrives — the one way a test can tell a process it
 * can no longer talk to over the pipe it just broke was actually asked to
 * leave, rather than left running unreaped.
 */
import { appendFileSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";

process.on("SIGTERM", () => {
  const marker = process.env.LYKEION_STUB_EXIT_MARKER;
  if (marker) appendFileSync(marker, `${process.pid}\n`);
  process.exit(0);
});

const args = process.argv.slice(2);
const dieOnIndex = args.indexOf("--die-on");
const dieOn = dieOnIndex === -1 ? undefined : args[dieOnIndex + 1];
const announceIndex = args.indexOf("--announce");
const announce = announceIndex === -1 ? undefined : args[announceIndex + 1];
const splitHello = args.includes("--split-hello");
const closeStdinOnIndex = args.indexOf("--close-stdin-on");
const closeStdinOn = closeStdinOnIndex === -1 ? undefined : args[closeStdinOnIndex + 1];
const languagesIndex = args.indexOf("--languages");
const languages = (languagesIndex === -1 ? "python" : (args[languagesIndex + 1] ?? ""))
  .split(",")
  .filter(Boolean);

// Reading stdin is otherwise the only handle keeping this process's own
// event loop open, so a run that is going to destroy it needs something
// else holding this process up first — registered here, before that
// happens, rather than in the same synchronous turn as the destroy itself.
if (closeStdinOn !== undefined) setInterval(() => {}, 60_000);

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (announce !== undefined) send({ method: announce, params: {} });

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
  if (message.method !== undefined && message.method === dieOn) process.exit(1);
  if (message.id === undefined) return;
  if (message.method === "host.hello") {
    const reply = `${JSON.stringify({
      id: message.id,
      result: {
        protocol: 2,
        languages: languages.map((language) => ({
          language,
          environment: language,
          reads: [],
        })),
      },
    })}\n`;
    if (splitHello) {
      const cut = Math.floor(reply.length / 2);
      process.stdout.write(reply.slice(0, cut));
      setTimeout(() => process.stdout.write(reply.slice(cut)), 20);
    } else {
      process.stdout.write(reply);
    }
  } else {
    send({ id: message.id, error: { message: `no method named ${message.method}` } });
  }
  if (message.method !== undefined && message.method === closeStdinOn) {
    input.close();
    process.stdin.destroy();
    closeSync(0);
  }
});
