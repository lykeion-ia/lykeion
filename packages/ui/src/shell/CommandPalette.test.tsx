/**
 * The command palette against the real workbench.
 *
 * The palette finds a Task by code or title from anywhere, without first
 * choosing the Research that holds it or being assigned it. Role/text-based,
 * agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { resetTabs, tabsSnapshot } from "../lib/tabs";
import { resetPageLoad } from "../lib/tabs-storage";

beforeEach(() => {
  cleanup();
  // The strip is module state, and these mount `App` once per test.
  resetTabs();
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});

/** Open the palette over the Researches list and hand back its input. */
async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  window.location.hash = "#/researches";
  render(<App api={createInMemoryApi()} />);
  await screen.findByText("Cross-modal plasticity in the brain");
  await user.keyboard("{Meta>}k{/Meta}");
  const palette = await screen.findByRole("dialog", { name: /command/i });
  return { palette, input: within(palette).getByRole("combobox") };
}

describe("finding a Task from the command palette", () => {
  it("surfaces a Task from part of its title and opens it", async () => {
    const user = userEvent.setup();
    const reference = createInMemoryApi();
    // CMP-7 is assigned to nobody, so the work My Tasks lists excludes it.
    const mine = new Set((await reference.myWork()).map((t) => t.id));
    expect(mine.has("t_7")).toBe(false);

    const { palette, input } = await openPalette(user);
    await user.type(input, "chemogenetic");

    // Exactly the one Task matches — a palette that offered everything would
    // satisfy a looser assertion.
    const options = within(palette).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(
      "CMP-7 · Draft a chemogenetic follow-up",
    );

    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(
      await screen.findByText(/CMP-7: Draft a chemogenetic follow-up/i),
    ).toBeInTheDocument();
  });

  it("opens a finished Task in a Research the query never names", async () => {
    const user = userEvent.setup();
    const reference = createInMemoryApi();
    const done = (await reference.getResearch("s_cmp")).tasks.find(
      (t) => t.id === "t_1",
    )!;
    expect(done.status).toBe("done");
    expect((await reference.myWork()).map((t) => t.id)).not.toContain("t_1");

    const { palette, input } = await openPalette(user);
    await user.type(input, "Survey cross-modal plasticity literature");

    // The Research "Cross-modal plasticity in the brain" is a competing match on
    // those words; the exact Task title has to win.
    await user.click(within(palette).getAllByRole("option")[0]);
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(
      await screen.findByText(/CMP-1: Survey cross-modal plasticity/i),
    ).toBeInTheDocument();
  });

  /**
   * Screens are not in here. Thirteen "Go to <section>" rows used to be, and
   * they crowded out what the palette is actually reached for; the rail is how
   * you get to a screen, and it is always on the page.
   */
  it("offers no screens, only Researches and their Tasks", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "Inbox");

    expect(within(palette).queryAllByRole("option")).toHaveLength(0);
    expect(within(palette).getByText("No matching commands")).toBeInTheDocument();
  });
});

/**
 * The pane beside the results, which exists so a result can be recognised
 * before it is opened rather than by opening it.
 */
describe("the palette's preview pane", () => {
  it("describes the highlighted result", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "chemogenetic");

    const preview = within(palette).getByTestId("palette-preview");
    // The Task's own code and title, then what tells it apart from another.
    expect(preview).toHaveTextContent("CMP-7");
    expect(preview).toHaveTextContent("Draft a chemogenetic follow-up");
    expect(preview).toHaveTextContent("Status");
  });

  it("follows the arrow keys down the list", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    // A query with several matches whose descriptions differ, so moving shows.
    await user.type(input, "plasticity");

    const options = within(palette).getAllByRole("option");
    const first = options[0].textContent ?? "";
    const second = options[1].textContent ?? "";
    expect(first).not.toBe(second);

    const preview = within(palette).getByTestId("palette-preview");
    const before = preview.textContent;
    await user.keyboard("{ArrowDown}");
    expect(preview.textContent).not.toBe(before);
  });

  it("describes a Research by its key and when it last moved", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "Cross-modal plasticity in the brain");

    const preview = within(palette).getByTestId("palette-preview");
    expect(preview).toHaveTextContent("Cross-modal plasticity in the brain");
    expect(preview).toHaveTextContent("CMP");
    expect(preview).toHaveTextContent("Updated");
  });

  it("shows nothing to describe when nothing matched", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "zzzzzz-no-such-command");

    expect(within(palette).getByText("No matching commands")).toBeInTheDocument();
    expect(within(palette).queryByTestId("palette-preview")).toBeNull();
  });

  /**
   * The pane restates the option the listbox has already announced, so a second
   * voice for the same thing would read the whole panel out again on every
   * arrow press.
   */
  it("keeps the preview out of the accessibility tree", async () => {
    const user = userEvent.setup();
    const { palette } = await openPalette(user);
    expect(within(palette).getByTestId("palette-preview")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("leaves the input as the palette's only tab stop", async () => {
    const user = userEvent.setup();
    const { input } = await openPalette(user);
    expect(document.activeElement).toBe(input);

    await user.tab();
    expect(document.activeElement).toBe(input);
  });
});

/**
 * The strip's `+` and ⌘K ask different questions. ⌘K is "take me there"; `+` is
 * "have this open as well", so what it finds lands beside the current tab rather
 * than replacing what is in it.
 */
describe("the strip's plus", () => {
  it("opens the palette instead of a tab on some fixed screen", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/researches";
    render(<App api={createInMemoryApi()} />);
    await screen.findByText("Cross-modal plasticity in the brain");
    const before = tabsSnapshot().tabs.length;

    await user.click(screen.getByRole("button", { name: "New tab" }));

    expect(
      await screen.findByRole("dialog", { name: /command/i }),
    ).toBeInTheDocument();
    // Nothing opened yet — the question has been asked, not answered.
    expect(tabsSnapshot().tabs).toHaveLength(before);
  });

  it("opens what it finds beside the current tab, not in it", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/researches";
    render(<App api={createInMemoryApi()} />);
    await screen.findByText("Cross-modal plasticity in the brain");
    const before = tabsSnapshot().tabs.length;

    await user.click(screen.getByRole("button", { name: "New tab" }));
    const palette = await screen.findByRole("dialog", { name: /command/i });
    await user.type(within(palette).getByRole("combobox"), "CMP-1");
    await user.keyboard("{Enter}");

    const state = tabsSnapshot();
    expect(state.tabs).toHaveLength(before + 1);
    const active = state.tabs.find((t) => t.id === state.activeId)!;
    expect(active.stack[active.index].route).toEqual({
      name: "task",
      researchId: "s_cmp",
      taskId: "t_1",
    });
    // And the tab that was active before is still on Researches.
    expect(state.tabs[0].stack[state.tabs[0].index].route).toEqual({
      name: "researches",
    });
  });

  it("still replaces the current tab's route when the palette is opened with ⌘K", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    const before = tabsSnapshot().tabs.length;

    await user.type(input, "CMP-1");
    await user.keyboard("{Enter}");

    expect(tabsSnapshot().tabs).toHaveLength(before);
    expect(palette).not.toBeInTheDocument();
  });
});

/**
 * The right-hand mark says what has been working on a row, which is the most
 * useful thing about a row that is otherwise a title. It replaced a text strip
 * that only ever said "Task".
 */
describe("the kind mark", () => {
  it("names a Task that has not run as a conversation, not as a run", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    // A Task with no turns against it: `agent` is written off the newest turn.
    const fresh = (await api.getResearch("s_cmp")).tasks.find(
      (t) => t.agent === undefined,
    );
    expect(fresh).toBeDefined();

    window.location.hash = "#/researches";
    render(<App api={api} />);
    await screen.findByText("Cross-modal plasticity in the brain");
    await user.keyboard("{Meta>}k{/Meta}");
    const palette = await screen.findByRole("dialog", { name: /command/i });
    await user.type(within(palette).getByRole("combobox"), fresh!.title);

    expect(
      within(palette).getByRole("option", { name: /not yet run/i }),
    ).toBeInTheDocument();
  });

  it("names a Research as a Research", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "Cross-modal plasticity in the brain");

    expect(
      within(palette).getByRole("option", { name: /Research$/ }),
    ).toBeInTheDocument();
  });
});

describe("match highlighting", () => {
  it("lights the typed text inside the label", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "plast");

    const hit = palette.querySelector(".palette-hit");
    expect(hit).not.toBeNull();
    expect(hit).toHaveTextContent(/plast/i);
  });

  /**
   * "gti" matches "Go to Inbox" only as a subsequence — there is no contiguous
   * run to point at, and `score()` is deliberately not taught to return ranges
   * for the sake of a decoration.
   */
  it("leaves a subsequence match unlit rather than guessing at ranges", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "gti");

    expect(within(palette).getAllByRole("option").length).toBeGreaterThan(0);
    expect(palette.querySelector(".palette-hit")).toBeNull();
  });
});
