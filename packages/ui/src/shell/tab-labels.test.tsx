/**
 * A tab is named by whoever read its subject.
 *
 * The strip stores labels rather than resolving them — that is what removed the
 * old pill's per-navigation `getResearch` and its "Task" flicker — so a Task's or a
 * Research's real title reaches the strip only because the mounted screen calls
 * `reconcileLabel`. Nothing else would put it there, and a tab would sit under
 * the generic name of its kind for as long as it stayed open.
 *
 * These mount the whole app, because the wiring under test spans three modules:
 * the screen that reads the subject, the store that holds the label, and the
 * strip that draws it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { resetTabs } from "../lib/tabs";
import { resetPageLoad } from "../lib/tabs-storage";

const CMP = "s_cmp";

beforeEach(() => {
  cleanup();
  resetTabs();
  resetPageLoad();
});

describe("tab labels", () => {
  it("names a Task's tab with its code and title, not the kind", async () => {
    const api = createInMemoryApi();
    const { tasks } = await api.getResearch(CMP);
    const first = tasks.find((t) => t.id === "t_1")!;
    window.location.hash = `#/researches/${CMP}/tasks/t_1`;

    render(<App api={api} />);

    // Code first, the way the single pill named it: a researcher who knows
    // "CMP-1" recognises the tab without reading the title.
    expect(
      await screen.findByRole("tab", {
        name: new RegExp(`CMP-1: ${first.title}`, "i"),
      }),
    ).toBeInTheDocument();
    // And the generic placeholder is gone once the real name has landed.
    expect(screen.queryByRole("tab", { name: /^Task$/ })).toBeNull();
  });

  it("names a Research's tab with its title", async () => {
    const api = createInMemoryApi();
    const { research } = await api.getResearch(CMP);
    window.location.hash = `#/researches/${CMP}`;

    render(<App api={api} />);

    expect(
      await screen.findByRole("tab", { name: new RegExp(research.title, "i") }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^Research$/ })).toBeNull();
  });
});
