import { describe, expect, it } from "vitest";
import { parseHash, routeHash, type Route } from "./router";

describe("parseHash", () => {
  it("defaults to Studies for empty or unknown hashes", () => {
    expect(parseHash("")).toEqual({ name: "studies" });
    expect(parseHash("#")).toEqual({ name: "studies" });
    expect(parseHash("#/")).toEqual({ name: "studies" });
    expect(parseHash("#/nonsense")).toEqual({ name: "studies" });
  });

  it("parses study and task routes", () => {
    expect(parseHash("#/studies")).toEqual({ name: "studies" });
    expect(parseHash("#/studies/s_cmp")).toEqual({
      name: "study",
      studyId: "s_cmp",
    });
    expect(parseHash("#/studies/s_cmp/tasks/t_3")).toEqual({
      name: "task",
      studyId: "s_cmp",
      taskId: "t_3",
    });
  });

  it("parses the new top-level routes", () => {
    expect(parseHash("#/my-tasks")).toEqual({ name: "my-tasks" });
    expect(parseHash("#/research-groups")).toEqual({ name: "research-groups" });
  });

  it("parses a Settings tab, and General as the bare route", () => {
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
    expect(parseHash("#/settings/skills")).toEqual({
      name: "settings",
      tab: "skills",
    });
  });

  // Skills, Connectors and Usage moved into Settings; their old hashes still
  // resolve so links and bookmarks survive, and the provider canonicalizes the
  // URL.
  it("redirects the old Skills, Connectors and Usage hashes into Settings", () => {
    expect(parseHash("#/skills")).toEqual({ name: "settings", tab: "skills" });
    expect(parseHash("#/connectors")).toEqual({
      name: "settings",
      tab: "connectors",
    });
    expect(parseHash("#/usage")).toEqual({ name: "settings", tab: "profile" });
    expect(routeHash(parseHash("#/skills"))).toBe("#/settings/skills");
    expect(routeHash(parseHash("#/usage"))).toBe("#/settings/profile");
  });

  // The Preferences tab was renamed Appearance, and a tab key IS its URL.
  it("redirects the old Preferences tab hash to Appearance", () => {
    expect(parseHash("#/settings/preferences")).toEqual({
      name: "settings",
      tab: "appearance",
    });
    expect(routeHash(parseHash("#/settings/preferences"))).toBe(
      "#/settings/appearance",
    );
  });

  it("parses an invite code off the join route, and falls back to Studies with none", () => {
    expect(parseHash("#/join/abc123")).toEqual({
      name: "join",
      code: "abc123",
    });
    expect(parseHash("#/join")).toEqual({ name: "studies" });
    expect(routeHash({ name: "join", code: "abc123" })).toBe("#/join/abc123");
  });

  it("reads a machine's pairing request off the query part of the hash", () => {
    expect(
      parseHash(
        "#/pair?name=demo-machine&platform=macos-aarch64&version=0.1.0&challenge=abc&state=xyz&redirect=http%3A%2F%2F127.0.0.1%3A9999%2Fpaired",
      ),
    ).toEqual({
      name: "pair",
      params: {
        name: "demo-machine",
        platform: "macos-aarch64",
        version: "0.1.0",
        challenge: "abc",
        state: "xyz",
        redirect: "http://127.0.0.1:9999/paired",
      },
    });
  });

  it("parses a bare #/pair with no query as an empty params object", () => {
    expect(parseHash("#/pair")).toEqual({ name: "pair", params: {} });
  });

  it("round-trips a pairing route's parameters through routeHash", () => {
    const route: Route = {
      name: "pair",
      params: {
        name: "demo-machine",
        platform: "macos-aarch64",
        version: "0.1.0",
        challenge: "abc",
        state: "xyz",
        redirect: "http://127.0.0.1:9999/paired",
      },
    };
    expect(parseHash(routeHash(route))).toEqual(route);
  });

  it("round-trips every route through routeHash", () => {
    const routes: Route[] = [
      { name: "studies" },
      { name: "study", studyId: "s_gen" },
      { name: "task", studyId: "s_gen", taskId: "t_8" },
      { name: "tasks" },
      { name: "unfiled-task", taskId: "t_9" },
      { name: "inbox" },
      { name: "my-work" },
      { name: "agents" },
      { name: "agent", agentId: "statistician" },
      { name: "workflows" },
      { name: "workflow", workflowId: "diffexpr" },
      { name: "machines" },
      { name: "settings" },
      { name: "settings", tab: "skills" },
      { name: "settings", tab: "connectors" },
      { name: "settings", tab: "profile" },
      { name: "my-tasks" },
      { name: "research-groups" },
      { name: "join", code: "inv_9" },
      { name: "pair", params: {} },
      { name: "pair", params: { name: "demo-machine", state: "xyz" } },
    ];
    for (const route of routes) {
      expect(parseHash(routeHash(route))).toEqual(route);
    }
  });

  it("round-trips the agent detail route", () => {
    expect(parseHash("#/agents/statistician")).toEqual({
      name: "agent",
      agentId: "statistician",
    });
    expect(routeHash({ name: "agent", agentId: "statistician" })).toBe(
      "#/agents/statistician",
    );
    expect(parseHash("#/agents")).toEqual({ name: "agents" });
  });

  it("round-trips the workflow detail route", () => {
    expect(parseHash("#/workflows/diffexpr")).toEqual({
      name: "workflow",
      workflowId: "diffexpr",
    });
    expect(routeHash({ name: "workflow", workflowId: "diffexpr" })).toBe(
      "#/workflows/diffexpr",
    );
    expect(parseHash("#/workflows")).toEqual({ name: "workflows" });
  });

  it("round-trips the setup route, so a step survives a reload", () => {
    expect(parseHash("#/setup/3")).toEqual({ name: "setup", step: 3 });
    expect(routeHash({ name: "setup", step: 3 })).toBe("#/setup/3");
  });

  it("reads a step it cannot make sense of as the first one", () => {
    // The address comes from outside the app — a redirect the daemon
    // composed, or a link somebody kept — so every unusable spelling has to
    // resolve to something, and starting over is the only answer that is
    // always safe to give.
    for (const hash of ["#/setup", "#/setup/", "#/setup/nonsense", "#/setup/0", "#/setup/-2"])
      expect(parseHash(hash)).toEqual({ name: "setup", step: 1 });
  });

  it("percent-encodes agent names in the route", () => {
    expect(routeHash({ name: "agent", agentId: "Deep Research" })).toBe(
      "#/agents/Deep%20Research",
    );
    expect(parseHash("#/agents/Deep%20Research")).toEqual({
      name: "agent",
      agentId: "Deep Research",
    });
  });
});
