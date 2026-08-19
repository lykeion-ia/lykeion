/**
 * What a route is called and what it looks like in the strip — the two things
 * the strip needs that a `Route` does not carry.
 *
 * Both are pure and derived from the route alone, which is the point: a tab's
 * glyph is never stored, so it cannot drift from the route it decorates, and a
 * stored label is only ever a better answer than these, never the only one.
 */
import { describe, expect, it } from "vitest";
import {
  FlaskIcon,
  InboxIcon,
  ListIcon,
  MonitorIcon,
  SparkleIcon,
} from "../components/icons";
import { routeGlyph, routeLabel } from "./route-chrome";

describe("routeLabel", () => {
  it("names a static screen the way the rail names it", () => {
    expect(routeLabel({ name: "inbox" })).toBe("Inbox");
    expect(routeLabel({ name: "machines" })).toBe("Machines");
    expect(routeLabel({ name: "tasks" })).toBe("Tasks");
    // "Experts", not "Agents" — the rail is the single source for that wording.
    expect(routeLabel({ name: "agents" })).toBe("Experts");
  });

  it("names Settings the same whichever tab is deep-linked", () => {
    expect(routeLabel({ name: "settings" })).toBe("Settings");
    expect(routeLabel({ name: "settings", tab: "skills" })).toBe("Settings");
  });

  it("gives a Task and a Research the generic name of their kind", () => {
    // A placeholder until the screen that read the subject calls
    // `reconcileLabel` with its real title. It shows on a cold entry only.
    expect(routeLabel({ name: "task", researchId: "s", taskId: "t" })).toBe("Task");
    expect(routeLabel({ name: "unfiled-task", taskId: "t" })).toBe("Task");
    expect(routeLabel({ name: "research", researchId: "s" })).toBe("Research");
  });

  it("names an Expert by the id, which needs no read", () => {
    // Deliberate: the name would take a fetch, and a tab that filled in
    // afterwards would change under the reader for the length of it.
    expect(routeLabel({ name: "agent", agentId: "claude" })).toBe("claude");
  });

  it("falls back rather than rendering an unnamed tab", () => {
    // `join` is never a tab, so nothing should ask — but a label of `undefined`
    // drawn into the strip would be worse than a wrong one.
    expect(routeLabel({ name: "join", code: "abc" })).toBe("Inbox");
  });
});

describe("routeGlyph", () => {
  it("takes a static screen's glyph from the rail entry", () => {
    expect(routeGlyph({ name: "inbox" })).toBe(InboxIcon);
    expect(routeGlyph({ name: "tasks" })).toBe(ListIcon);
    expect(routeGlyph({ name: "machines" })).toBe(MonitorIcon);
  });

  it("marks a Research and its Tasks with the Research glyph", () => {
    expect(routeGlyph({ name: "researches" })).toBe(FlaskIcon);
    expect(routeGlyph({ name: "research", researchId: "s" })).toBe(FlaskIcon);
    expect(routeGlyph({ name: "task", researchId: "s", taskId: "t" })).toBe(
      FlaskIcon,
    );
    expect(routeGlyph({ name: "unfiled-task", taskId: "t" })).toBe(FlaskIcon);
  });

  it("marks a detail route with its section's glyph, not the section's", () => {
    // `agent` is a singular route name the rail has no entry for.
    expect(routeGlyph({ name: "agent", agentId: "claude" })).toBe(SparkleIcon);
  });

  it("falls back rather than rendering a tab with no glyph", () => {
    expect(routeGlyph({ name: "join", code: "abc" })).toBe(InboxIcon);
  });
});
