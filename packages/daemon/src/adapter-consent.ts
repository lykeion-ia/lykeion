import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which community-published adapters the researcher has agreed to run, and
 * as which agent.
 *
 * The agreement is about where an adapter runs rather than what it does. It
 * is spawned inside the boundary with read and write on the Lykeion-owned
 * home for its agent — which holds the credential that agent signed in with —
 * and the profile allows outbound network without restriction, because the
 * agent has to reach its vendor's API. So an adapter has both the credential
 * and a way to send it somewhere, and who wrote it is the only thing that
 * varies between one adapter and the next.
 *
 * Scoped to `(agent, command)`. Accepting a program to run as one agent is
 * not accepting it to run as another, because the credential it can reach is
 * different each time. NOT scoped to a version: re-asking on every upgrade is
 * the more defensible supply-chain position and the worse outcome, because a
 * prompt that appears on every routine upgrade is a prompt people learn to
 * dismiss without reading. A compromised release of an already-accepted
 * adapter is therefore not caught here, and that is a known limit rather than
 * an oversight.
 */
const CONSENT_FILE = "adapter-consent.json";

export function consentPath(dir: string): string {
  return join(dir, CONSENT_FILE);
}

/** One accepted adapter, as one string, so the whole set is a `Set` lookup
 *  on the probe's hot path rather than a scan. */
export function consentKey(agent: string, command: string): string {
  return `${agent}:${command}`;
}

/**
 * What has been accepted, read back.
 *
 * A file that is not there is not a failure — every daemon starts having
 * accepted nothing. A file that will not parse is read the same way, which is
 * the opposite of how `readState` treats its own garbage and deliberately so:
 * a pairing token that will not parse must stop the daemon rather than be
 * quietly replaced, whereas the worst case here is that a researcher is asked
 * again. Throwing would strand a machine on a file nobody can repair from the
 * screen that writes it.
 */
export function acceptedAdapters(dir: string): ReadonlySet<string> {
  try {
    const raw = readFileSync(consentPath(dir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

function write(dir: string, keys: ReadonlySet<string>): void {
  mkdirSync(dir, { recursive: true });
  const path = consentPath(dir);
  // `0600` for the reason `writeState` is: this file decides what gets to run
  // beside a credential, and another account editing it decides that too.
  // Set again after the write, because `mode` is only honoured on create.
  writeFileSync(path, JSON.stringify([...keys]), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function acceptAdapter(dir: string, agent: string, command: string): void {
  const keys = new Set(acceptedAdapters(dir));
  keys.add(consentKey(agent, command));
  write(dir, keys);
}

export function revokeAdapter(dir: string, agent: string, command: string): void {
  const keys = new Set(acceptedAdapters(dir));
  keys.delete(consentKey(agent, command));
  write(dir, keys);
}
