import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWorkspaceServer, selectApi } from "./select";
import { formatAgo } from "../lib/task-meta";

describe("selectApi", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("boots with populated data so every screen has something to show", async () => {
    const researches = await selectApi().api.listResearches();
    expect(researches.length).toBeGreaterThan(0);
  });

  it("boots blank when the seed is set to empty", async () => {
    window.history.replaceState({}, "", "/?seed=empty");
    expect(await selectApi().api.listResearches()).toEqual([]);
  });

  it("stamps a Research created through its own data layer at the real present, not the seed's fixture time", async () => {
    // `selectApi` must hand the data layer a real clock base, or every Research
    // created in the running app reads as old as the seed data instead of
    // just made. Nothing else covers that argument.
    const research = await selectApi().api.createResearch({
      title: "Live",
      key: "LIV",
    });
    expect(formatAgo(research.createdTs)).toBe("just now");
  });

  it("has no transport in demo mode, since there is no server to subscribe to", () => {
    expect(selectApi().transport).toBeUndefined();
  });

  it("uses the lab's records when the served document says a server is behind it", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "lykeion-workspace");
    meta.setAttribute("content", "1");
    document.head.appendChild(meta);
    try {
      expect(hasWorkspaceServer()).toBe(true);
    } finally {
      meta.remove();
    }
  });

  it("hands back the same transport the api calls through, so the change channel rides one connection", async () => {
    // Sameness is observable through the one-announcement-per-lapse latch
    // the transport holds: two transports would each hold their own, and a
    // single lapse would prompt for a sign-in twice. Asserting the object
    // merely exists would pass just as well against two of them.
    const meta = document.createElement("meta");
    meta.setAttribute("name", "lykeion-workspace");
    meta.setAttribute("content", "1");
    document.head.appendChild(meta);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
    const onUnauthenticated = vi.fn();
    try {
      const { api, transport } = selectApi(onUnauthenticated);
      await api.currentUser().catch(() => {});
      await transport!.request("listResearches", []).catch(() => {});
      expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      meta.remove();
    }
  });

  it("falls back to seeded local data when nothing says otherwise", () => {
    expect(hasWorkspaceServer()).toBe(false);
  });
});
