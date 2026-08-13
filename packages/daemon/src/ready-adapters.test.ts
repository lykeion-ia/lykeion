import { expect, it } from "vitest";
import { adapterFor, rememberAdapters } from "./ready-adapters";

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
