import { afterEach, expect, it } from "vitest";
import {
  DEMOTION_HOLD_SECONDS,
  demotionsFor,
  forgetDemotions,
  isDemoted,
  recordDemotion,
} from "./agent-demotions";

afterEach(() => forgetDemotions());

it("remembers when a demotion happened, not only that one did", () => {
  recordDemotion("claude", "401 OAuth access token has been revoked", () => 1_700_000_000);
  expect(demotionsFor("claude")).toEqual([
    { agent: "claude", at: 1_700_000_000, reason: "401 OAuth access token has been revoked" },
  ]);
});

it("keeps one agent's demotions out of another's", () => {
  recordDemotion("claude", "revoked", () => 1);
  recordDemotion("codex", "revoked", () => 2);
  expect(demotionsFor("claude")).toHaveLength(1);
  expect(demotionsFor("codex")).toHaveLength(1);
});

it("keeps the newest and drops the oldest past the cap", () => {
  for (let i = 0; i < 30; i += 1) recordDemotion("claude", `failure ${i}`, () => i);
  const kept = demotionsFor("claude");
  expect(kept).toHaveLength(20);
  expect(kept[0]?.reason).toBe("failure 10");
  expect(kept[19]?.reason).toBe("failure 29");
});

it("answers with nothing for an agent that has never failed", () => {
  expect(demotionsFor("codex")).toEqual([]);
});

it("holds an agent back while its newest demotion is younger than a probe cycle", () => {
  recordDemotion("claude", "revoked", () => 1_000);
  expect(isDemoted("claude", () => 1_000 + DEMOTION_HOLD_SECONDS - 1)).toBe(true);
});

it("stops holding an agent back once its newest demotion is older than a probe cycle", () => {
  // The whole reason this is a window and not a flag: the next cycle asks the
  // CLI again, so a researcher who signed back in is offered the agent
  // without restarting anything.
  recordDemotion("claude", "revoked", () => 1_000);
  expect(isDemoted("claude", () => 1_000 + DEMOTION_HOLD_SECONDS + 1)).toBe(false);
});

it("holds nothing back for an agent that has never failed", () => {
  expect(isDemoted("codex", () => 1_000)).toBe(false);
});

it("weighs the newest demotion, not the oldest", () => {
  // Recorded out of chronological order on purpose — the newest arrives
  // FIRST, so it is not also last by array position. An implementation that
  // read `kept.at(-1)` instead of the greatest `at` would grab "revoked at
  // breakfast" here and wrongly report the window closed for a failure that
  // in fact happened a moment ago.
  recordDemotion("claude", "revoked just now", () => 1_000 + DEMOTION_HOLD_SECONDS * 4);
  recordDemotion("claude", "revoked at breakfast", () => 1_000);
  expect(isDemoted("claude", () => 1_000 + DEMOTION_HOLD_SECONDS * 4 + 1)).toBe(true);
});
