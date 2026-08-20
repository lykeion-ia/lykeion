import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labLabel,
  labMovedTo,
  readState,
  revokedStatePath,
  setAsidePairing,
  writeState,
  type PairedState,
} from "./state";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-state-"));
  dirs.push(dir);
  return dir;
}

const SAMPLE: PairedState = {
  lab: "https://lab.uni.edu",
  token: "a-machine-token",
  runtimeId: "rt_1",
  machineName: "ana-macbook",
  labName: "Ana's Lab",
};

it("writes the state file mode 0600", () => {
  const dir = freshDir();
  writeState(dir, SAMPLE);
  const mode = statSync(join(dir, "state.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

it("reads back exactly what was written", () => {
  const dir = freshDir();
  writeState(dir, SAMPLE);
  expect(readState(dir)).toEqual(SAMPLE);
});

it("reads a missing file as undefined rather than throwing", () => {
  const dir = freshDir();
  expect(readState(dir)).toBeUndefined();
});

it("reports a corrupt file as corrupt rather than silently discarding it", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "state.json"), "{not json");
  expect(() => readState(dir)).toThrow(/not valid JSON/);
});

it("leaves a machine unpaired once its pairing has been set aside", () => {
  // What a lab refusing this machine's token means for the directory: the
  // token stored there is not this machine's identity any more, and the
  // next start has to be an unpaired one that offers a link rather than one
  // that announces a pairing the lab has disowned.
  const dir = freshDir();
  writeState(dir, SAMPLE);
  expect(setAsidePairing(dir)).toBe(true);
  expect(readState(dir)).toBeUndefined();
  expect(existsSync(join(dir, "state.json"))).toBe(false);
});

it("keeps the pairing it set aside where somebody can read it", () => {
  // Renamed rather than deleted. Which lab, which machine record, what the
  // machine was called: the whole of what a person has to go on when a
  // machine disappears from a lab's Machines screen and nobody remembers
  // doing it. The token in it is spent — the lab refusing it is why this
  // happened — and it is still a credential, so the mode travels with it.
  const dir = freshDir();
  writeState(dir, SAMPLE);
  setAsidePairing(dir);
  expect(JSON.parse(readFileSync(revokedStatePath(dir), "utf8"))).toEqual(SAMPLE);
  expect(statSync(revokedStatePath(dir)).mode & 0o777).toBe(0o600);
});

it("says so rather than throwing when there is no pairing to set aside", () => {
  // Reached by a daemon refused twice, or by one refused before it ever
  // wrote a token. Neither is a failure, and neither is worth a line telling
  // somebody a pairing was cleared that was never there.
  const dir = freshDir();
  expect(setAsidePairing(dir)).toBe(false);
  expect(existsSync(revokedStatePath(dir))).toBe(false);
});

it("replaces an earlier set-aside pairing rather than piling them up", () => {
  const dir = freshDir();
  writeState(dir, SAMPLE);
  setAsidePairing(dir);
  const second: PairedState = { ...SAMPLE, token: "a-later-machine-token", runtimeId: "rt_2" };
  writeState(dir, second);
  setAsidePairing(dir);
  expect(JSON.parse(readFileSync(revokedStatePath(dir), "utf8"))).toEqual(second);
});

it("calls a lab by the name it gave, and by its address when it gave none", () => {
  expect(labLabel(SAMPLE)).toBe("Ana's Lab");
  expect(labLabel({ ...SAMPLE, labName: "" })).toBe("https://lab.uni.edu");
});

it("keeps mode 0600 even overwriting a file that already had looser permissions", () => {
  const dir = freshDir();
  const path = join(dir, "state.json");
  writeFileSync(path, "{}", { mode: 0o644 });
  writeState(dir, SAMPLE);
  const mode = statSync(path).mode & 0o777;
  expect(mode).toBe(0o600);
});

it("re-points a self-hosted lab at the port it actually came up on", () => {
  // A daemon that hosts its own lab spawns it on a FREE port, chosen fresh on
  // every start and read back from the child's own startup line. The address
  // recorded when this machine paired is therefore stale the moment the
  // daemon restarts — and everything this machine says to its lab goes to
  // that address: `heartbeat`, `report`, and the declarations fetch.
  //
  // Nothing crashes. The daemon retries a dead port for ever, the lab never
  // hears from the machine again, and every surface fed by those reports goes
  // quiet — including Setup, which cannot offer to build an environment for a
  // machine that has not said what it holds. The page says exactly that, and
  // it reads like a UI fault rather than a daemon addressing nowhere.
  expect(labMovedTo({ ...SAMPLE, lab: "http://127.0.0.1:61047" }, 64286)).toEqual({
    ...SAMPLE,
    lab: "http://127.0.0.1:64286",
  });
});

it("leaves the state file alone when the self-hosted lab kept its port", () => {
  // The write is what makes this durable, and a write on every start would
  // rewrite a file holding a bearer token for no reason. `undefined` means
  // "nothing to persist", not "no lab".
  expect(labMovedTo({ ...SAMPLE, lab: "http://127.0.0.1:64286" }, 64286)).toBeUndefined();
});

it("has nothing to re-point when this machine has never paired", () => {
  // A first run has no state file at all, and pairing writes the address
  // itself a moment later. Answering with a half-made state here would put a
  // lab address on disk with no token beside it.
  expect(labMovedTo(undefined, 64286)).toBeUndefined();
});
