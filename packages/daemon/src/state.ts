import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What this machine knows once a lab has vouched for it: the bearer token
 *  that authenticates every call after pairing, and enough about the lab
 *  and the machine record it was given to report on itself sensibly. */
export interface PairedState {
  lab: string;
  token: string;
  runtimeId: string;
  machineName: string;
  labName: string;
}

const STATE_FILE = "state.json";

/** Where a pairing the lab has disowned is kept. */
const REVOKED_STATE_FILE = "state.revoked.json";

export function statePath(dir: string): string {
  return join(dir, STATE_FILE);
}

export function revokedStatePath(dir: string): string {
  return join(dir, REVOKED_STATE_FILE);
}

/**
 * What to call the lab this machine is paired with, wherever that is said to
 * a person. The name the lab gave for itself when it is one — a lab that has
 * never been given a name answers the empty string for it, and that is the
 * common case rather than the odd one — and the address it was reached at
 * otherwise. Naming nothing at all is the one thing this must not do: a
 * sentence that says a machine belongs to the empty string reads as a
 * machine that belongs to nobody.
 */
export function labLabel(state: PairedState): string {
  return state.labName || state.lab;
}

/**
 * The one on-disk fact this machine holds about itself, read back. A file
 * that is not there yet is not a failure — every daemon starts unpaired —
 * so that case answers `undefined` rather than throwing. A file that is
 * there but will not parse is a different situation entirely: something
 * wrote garbage, or a person hand-edited it, and treating that the same as
 * "not paired yet" would silently start pairing over again on top of
 * whatever bearer token that file already holds a claim to.
 */
export function readState(dir: string): PairedState | undefined {
  let raw: string;
  try {
    raw = readFileSync(statePath(dir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as PairedState;
  } catch {
    throw new Error(`the state file at ${statePath(dir)} is not valid JSON`);
  }
}

/**
 * The state to persist when a self-hosted lab came up somewhere new, or
 * `undefined` when there is nothing to write.
 *
 * A daemon whose lab lives on this computer starts that lab itself, and the
 * lab takes a FREE port — chosen fresh on every start, read back from the
 * child's own startup line (see `startLabChild`). The address in this file
 * was written once, when the machine paired, and every restart after that
 * leaves it naming a port nothing is listening on.
 *
 * That address is not decoration: `heartbeat`, `report` and the declarations
 * fetch all send to `machine.lab`. Pointed at a dead port they retry for
 * ever, so the lab never hears from the machine again, `runtimes.environments`
 * stays as it was, and every surface built on those reports goes quiet — the
 * notebook's Setup among them, which cannot offer to build an environment for
 * a machine that has not said what it holds. The proxy keeps working, because
 * it is handed the live port directly, which is why the application looks
 * healthy while the machine behind it has gone silent.
 *
 * Answers `undefined` rather than the same state back when the port has not
 * moved: the write is what makes this durable, and rewriting a file holding a
 * bearer token on every start earns nothing.
 */
export function labMovedTo(state: PairedState | undefined, port: number): PairedState | undefined {
  if (state === undefined) return undefined;
  const here = `http://127.0.0.1:${port}`;
  return state.lab === here ? undefined : { ...state, lab: here };
}

/**
 * Holds a bearer token, so the file it lives in is written mode `0600` —
 * readable and writable by this machine's own account only. `writeFileSync`'s
 * own `mode` option is only honoured while the file is being created; a
 * second pairing overwriting a file that already exists leaves whatever
 * permissions that file already had, so the mode is set again explicitly
 * after every write rather than trusted to the create path alone.
 */
export function writeState(dir: string, state: PairedState): void {
  mkdirSync(dir, { recursive: true });
  const path = statePath(dir);
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Puts aside the pairing this machine was holding, because the lab has said
 * it does not recognise it any more. Answers whether there was one.
 *
 * A machine removed from a lab has to be able to come back, and it comes
 * back by pairing again — which a daemon that goes on reading a repudiated
 * token as its identity never offers. So the token stops being this
 * machine's identity at the moment the lab says it is not: the file is
 * renamed rather than read past, which is what makes the next start an
 * unpaired one that prints a link.
 *
 * Renamed rather than deleted. What is in it — which lab, which machine
 * record, what the machine was called — is the whole of what a person has to
 * go on when a machine drops off the Machines screen and nobody knows why,
 * and a rename is the version of this that answers that question without
 * ever leaving a live pairing where a stale one is being read. The token
 * inside is spent: the lab refusing it is the reason this is being called at
 * all. It travels with the file's own mode, so what was `0600` stays `0600`,
 * and one rename replaces any earlier one rather than piling them up.
 */
export function setAsidePairing(dir: string): boolean {
  try {
    renameSync(statePath(dir), revokedStatePath(dir));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
