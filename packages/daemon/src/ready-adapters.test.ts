import { expect, it } from "vitest";
import {
  adapterFor,
  heldBackReason,
  rememberAdapters,
  rememberHeldBack,
} from "./ready-adapters";

it("hands a run the same program the probe vetted, arguments included", () => {
  // The invariant `main.ts` has always claimed. It used to hold only because
  // two call sites independently wrote the same empty argument list; here the
  // spec the probe vetted is the spec a run is launched with, so there is no
  // second place for the two to disagree.
  const vetted = { command: "/opt/bin/agy", args: ["--acp"], provenance: "vendor" as const };
  rememberAdapters(new Map([["antigravity", vetted]]));
  expect(adapterFor("antigravity")).toEqual({ command: "/opt/bin/agy", args: ["--acp"] });
});

it("refuses an agent no probe cycle ever vetted", () => {
  rememberAdapters(new Map());
  expect(adapterFor("antigravity")).toBeUndefined();
});

it("forgets an agent a later cycle no longer vetted", () => {
  // A probe cycle replaces the whole map rather than merging into it: an
  // adapter uninstalled between cycles must stop being launchable, and a merge
  // would leave the old entry standing.
  rememberAdapters(new Map([["codex", { command: "/a/codex-acp", args: [], provenance: "protocol" as const }]]));
  rememberAdapters(new Map());
  expect(adapterFor("codex")).toBeUndefined();
});

it("cannot be mutated through the arguments it handed out", () => {
  // `args` reaches a spawn site, and a caller that appended to it would be
  // editing what every later run of this agent is started with. Copied on the
  // way out so the vetted spec stays the vetted spec.
  const vetted = { command: "/opt/bin/agy", args: ["--acp"], provenance: "vendor" as const };
  rememberAdapters(new Map([["antigravity", vetted]]));
  adapterFor("antigravity")!.args.push("--dangerous");
  expect(adapterFor("antigravity")).toEqual({ command: "/opt/bin/agy", args: ["--acp"] });
});

// ---------------------------------------------------------------------------
// Why an agent is not launchable, as opposed to whether it is.
//
// A run refused for an agent this machine cannot start used to say one
// sentence for every cause: "this machine has no adapter for claude". That is
// the right answer for exactly one of them. For a CLI whose token lapsed
// overnight — the common one, and the one that resolves in a minute — it is
// wrong, and it sends the researcher to install a bridge they already have.
// ---------------------------------------------------------------------------

it("remembers why an agent it did not vet was held back", () => {
  rememberAdapters(new Map());
  rememberHeldBack(new Map([["claude", "sign in to Claude Code to run it"]]));
  expect(heldBackReason("claude")).toBe("sign in to Claude Code to run it");
});

it("says nothing about an agent that is perfectly fine", () => {
  rememberHeldBack(new Map());
  expect(heldBackReason("claude")).toBeUndefined();
});

it("forgets a reason once a later cycle no longer has one", () => {
  // The same wholesale replacement `rememberAdapters` does, and for the same
  // reason: a researcher who signs back in must not go on being told they are
  // signed out, and a merge would leave the old sentence standing forever.
  rememberHeldBack(new Map([["claude", "not signed in"]]));
  rememberHeldBack(new Map());
  expect(heldBackReason("claude")).toBeUndefined();
});
