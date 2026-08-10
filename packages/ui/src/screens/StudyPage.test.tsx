/**
 * The Study page: what a research line shows when you open it.
 *
 * This page is a click-path to every Task a Study holds, whoever it is
 * assigned to and whether or not it is finished. My Tasks is scoped to your
 * own unfinished work, so it is not one. Role/text-based, agnostic to the
 * markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  cleanup,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type LykeionApi } from "@lykeion/api";
import App from "../App";

const CMP = "s_cmp";
const ECO = "s_eco";

const RAIL_CARDS = ["Instructions", "Memory", "Scientific stages", "Files"];

beforeEach(cleanup);

/** Open a Study directly, the way the URL bar does. */
function openStudy(studyId: string, api = createInMemoryApi()) {
  window.location.hash = `#/studies/${studyId}`;
  render(<App api={api} />);
  return api;
}

const taskList = () => screen.getByRole("region", { name: "All tasks" });

/**
 * Where a Task row on this page points: at the Task. A Task is a chat, so
 * there is one destination — the work and the conversation about it are the
 * same page.
 */
function rowHref(studyId: string, taskId: string) {
  return `#/studies/${studyId}/tasks/${taskId}`;
}

describe("the Study page", () => {
  it("heads the page with the Study's title and description", async () => {
    const api = openStudy(CMP);
    const { study } = await api.getStudy(CMP);

    expect(
      await screen.findByRole("heading", { name: study.title, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(study.description!)).toBeInTheDocument();
  });

  it("carries the same breadcrumb the Task surface carries, so opening a Task does not move it", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const { study, tasks } = await api.getStudy(CMP);
    const crumb = () => screen.getByRole("navigation", { name: "Breadcrumb" });

    await waitFor(() =>
      expect(within(crumb()).getByText(study.title)).toBeInTheDocument(),
    );
    expect(
      within(crumb()).getByRole("link", { name: "Studies" }),
    ).toHaveAttribute("href", "#/studies");

    // The strip the trail sits in, which is what fixes where it lands on the
    // page. Held across the click below: a second strip built by hand on one
    // side of the hand-off is how the crumb ends up a few pixels off.
    const strip = crumb().parentElement!.className;

    // The trail is the same one the Task surface shows, so the strip reads
    // unchanged across the click that opens a run.
    await user.click(within(taskList()).getByText(tasks[0].title).closest("a")!);
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(within(crumb()).getByText(study.title)).toBeInTheDocument();
    expect(
      within(crumb()).getByRole("link", { name: "Studies" }),
    ).toHaveAttribute("href", "#/studies");
    expect(crumb().parentElement!.className).toBe(strip);
  });

  it("takes the Study's name in a Task's breadcrumb back up to the Study", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const { study } = await api.getStudy(CMP);
    window.location.hash = `#/studies/${CMP}/tasks/t_3`;
    render(<App api={api} />);
    await screen.findByTestId("task-surface");

    // The way back up from a run: the crumb names the Study it belongs to, and
    // that name is the link to it.
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const up = within(crumb).getByRole("link", { name: study.title });
    expect(up).toHaveAttribute("href", `#/studies/${CMP}`);

    await user.click(up);
    expect(
      await screen.findByRole("heading", { name: study.title, level: 1 }),
    ).toBeInTheDocument();
  });

  it("leaves the Study's name in its own breadcrumb unlinked — it is the page you are on", async () => {
    const api = openStudy(CMP);
    const { study } = await api.getStudy(CMP);
    const crumb = await screen.findByRole("navigation", { name: "Breadcrumb" });

    await waitFor(() =>
      expect(within(crumb).getByText(study.title)).toBeInTheDocument(),
    );
    expect(
      within(crumb).queryByRole("link", { name: study.title }),
    ).not.toBeInTheDocument();
  });

  it("lists every Task in the Study in number order, not only the ones assigned to me", async () => {
    const api = openStudy(CMP);
    const all = (await api.getStudy(CMP)).tasks;
    const mine = (await api.myWork()).filter((t) => t.studyId === CMP);

    // The premise: My Tasks genuinely cannot reach all of them. Without this
    // the rest of the test would hold on a page that only showed my own work.
    expect(all.length).toBeGreaterThan(mine.length);
    expect(all.length).toBeGreaterThan(2);

    await screen.findByRole("region", { name: "All tasks" });
    // Every row, in order, pointing at its own Task's chat — a page that
    // dropped one, added one, or reordered them fails here.
    expect(
      within(taskList())
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(all.map((t) => rowHref(CMP, t.id)));
    for (const task of all) {
      expect(within(taskList()).getByText(task.title)).toBeInTheDocument();
    }
  });

  it("lists the Task nobody is assigned to alongside the rest", async () => {
    const api = openStudy(CMP);
    const all = (await api.getStudy(CMP)).tasks;
    const orphans = all.filter((t) => !t.assignees);
    // The premise: exactly one seeded Task has no assignee, and My Tasks —
    // which reads assignment — cannot see it.
    expect(orphans.map((t) => t.id)).toEqual(["t_7"]);
    expect((await api.myWork()).map((t) => t.id)).not.toContain("t_7");

    await screen.findByRole("region", { name: "All tasks" });
    expect(
      within(taskList()).getByText(orphans[0].title).closest("a"),
    ).toHaveAttribute("href", `#/studies/${CMP}/tasks/t_7`);
  });

  it("opens a Task that is already finished", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    await screen.findByRole("region", { name: "All tasks" });

    // CMP-1 is done, so myWork() drops it.
    const done = (await api.getStudy(CMP)).tasks.find((t) => t.id === "t_1")!;
    expect(done.status).toBe("done");
    expect((await api.myWork()).map((t) => t.id)).not.toContain("t_1");

    await user.click(within(taskList()).getByText(done.title).closest("a")!);
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(
      await screen.findByText(new RegExp(`CMP-1: ${done.title}`, "i")),
    ).toBeInTheDocument();
  });

  it("opens the Task nobody is assigned to", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    await screen.findByRole("region", { name: "All tasks" });

    const orphan = (await api.getStudy(CMP)).tasks.find((t) => t.id === "t_7")!;
    expect(orphan.assignees).toBeUndefined();
    expect((await api.myWork()).map((t) => t.id)).not.toContain("t_7");

    await user.click(within(taskList()).getByText(orphan.title).closest("a")!);
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(
      await screen.findByText(new RegExp(`CMP-7: ${orphan.title}`, "i")),
    ).toBeInTheDocument();
  });

  it("puts the Tasks under the composer, under the name", async () => {
    openStudy(CMP);
    const tasks = await screen.findByRole("region", { name: "All tasks" });
    const { study } = await createInMemoryApi().getStudy(CMP);

    // The whole main column, in reading order: the Study is named, then it
    // offers the composer, then it shows the work. The composer carries no
    // heading of its own — the page's title is the only thing that asks.
    const title = screen.getByRole("heading", { name: study.title, level: 1 });
    const composer = screen.getByRole("region", { name: "Start a task" });
    const before = (a: Node, b: Node) =>
      Boolean(
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
      );

    expect(before(title, composer)).toBe(true);
    expect(before(composer, tasks)).toBe(true);
  });

  it("counts the Study's Tasks across the six scientific stages", async () => {
    openStudy(CMP);
    const card = await screen.findByRole("region", {
      name: "Scientific stages",
    });

    const rows = within(card)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    // Every stage is shown in canonical order, including the empty one — the
    // arc is the point, and a missing row would read as a missing stage.
    expect(rows).toEqual([
      "Background1",
      "Hypothesis1",
      "Methods2",
      "Results2",
      "Future directions1",
      "Conclusions0",
    ]);
  });

  it("shows the instructions and writes an edit back to the Study", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const before = (await api.getStudy(CMP)).study.agentContext!;

    const card = await screen.findByRole("region", { name: "Instructions" });
    expect(within(card).getByText(before)).toBeInTheDocument();

    await user.click(
      within(card).getByRole("button", { name: "Edit instructions" }),
    );
    const box = within(card).getByRole("textbox", { name: "Instructions" });
    await user.clear(box);
    await user.type(box, "Sessions are registered across days.");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    // It reached the core, not just the card's own state.
    await waitFor(async () => {
      expect((await api.getStudy(CMP)).study.agentContext).toBe(
        "Sessions are registered across days.",
      );
    });
    expect(
      await within(card).findByText("Sessions are registered across days."),
    ).toBeInTheDocument();
  });

  it("stacks the rail's four cards in order beside the main column", async () => {
    openStudy(CMP);
    await screen.findByRole("region", { name: "Instructions" });

    const labels = screen
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label") ?? "");
    expect(labels.filter((l) => RAIL_CARDS.includes(l))).toEqual(RAIL_CARDS);
    // The list of work comes before the rail in reading order.
    expect(labels.indexOf("All tasks")).toBeLessThan(
      labels.indexOf("Instructions"),
    );
  });

  it("offers no control on the cards that have nothing behind them", async () => {
    openStudy(CMP);

    for (const name of ["Memory", "Files"]) {
      const card = await screen.findByRole("region", { name });
      expect(within(card).queryByRole("button")).not.toBeInTheDocument();
      expect(within(card).queryByRole("link")).not.toBeInTheDocument();
      // …and each says so rather than sitting blank.
      expect(within(card).getByText(/nothing|no files/i)).toBeInTheDocument();
    }

    // The card that is backed by something does offer its control.
    const instructions = screen.getByRole("region", { name: "Instructions" });
    expect(
      within(instructions).getByRole("button", { name: "Edit instructions" }),
    ).toBeInTheDocument();
  });

  it("starts the description and the rail's panel on the same line", async () => {
    // The one structural assertion in this file. The alignment the design
    // asks for is produced by where these two boxes sit — each the first
    // thing in its column — so text and roles cannot express it.
    openStudy(CMP);
    await screen.findByRole("region", { name: "Instructions" });

    const description = document.querySelector(".study-description");
    const main = document.querySelector(".study-main");
    const rail = document.querySelector(".study-rail");
    expect(description).not.toBeNull();
    expect(main?.firstElementChild).toBe(description);
    expect(rail?.firstElementChild).toHaveClass("study-rail-panel");

    // …and the head above the columns keeps the name alone.
    expect(document.querySelector(".study-head")).not.toContainElement(
      description as HTMLElement,
    );
  });

  it("puts every Task in the workbench on the page of the Study that holds it", async () => {
    const reference = createInMemoryApi();
    const studies = await reference.listStudies();
    const everyTask = (
      await Promise.all(studies.map((s) => reference.getStudy(s.id)))
    ).flatMap((d) => d.tasks);
    // Every filed Task in the seed, and the premise this page answers: My
    // Tasks is scoped to your own unfinished work, so some of them have no
    // route through it. Stated as that relationship rather than as a count,
    // which drifts every time the seed grows a task.
    expect(everyTask).toHaveLength(12);
    const reachableFromMyWork = new Set(
      (await reference.myWork()).map((t) => t.id),
    );
    expect(
      everyTask.filter((t) => !reachableFromMyWork.has(t.id)).length,
    ).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const study of studies) {
      cleanup();
      const api = openStudy(study.id);
      await screen.findByRole("region", { name: "All tasks" });
      const region = taskList();
      for (const task of (await api.getStudy(study.id)).tasks) {
        // A row, with an href — clicking it is the whole point.
        const row = within(region).getByText(task.title).closest("a");
        expect(row).toHaveAttribute("href", rowHref(study.id, task.id));
        seen.add(task.id);
      }
    }
    expect(seen.size).toBe(12);
  });

  it("opens a Task on the Task surface, talked-to or not", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    // The premise: t_3 has been talked to and t_4 has not — so if the two
    // rows could land in different places, these are the two that would.
    const tasksOf = async () => (await api.getStudy(CMP)).tasks;
    const t3 = (await tasksOf()).find((t) => t.id === "t_3")!;
    const t4 = (await tasksOf()).find((t) => t.id === "t_4")!;
    expect(t3.runCount).toBeGreaterThan(0);
    expect(t4.runCount).toBe(0);

    await screen.findByRole("region", { name: "All tasks" });

    // The Task with a transcript opens its own surface…
    const talkedTo = within(taskList()).getByText(t3.title);
    expect(talkedTo.closest("a")).toHaveAttribute(
      "href",
      `#/studies/${CMP}/tasks/t_3`,
    );
    await user.click(talkedTo.closest("a")!);
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();

    // …and so does the one nobody has spoken in. One row, one destination.
    cleanup();
    openStudy(CMP, api);
    await screen.findByRole("region", { name: "All tasks" });
    expect(
      within(taskList()).getByText(t4.title).closest("a"),
    ).toHaveAttribute("href", `#/studies/${CMP}/tasks/t_4`);
  });

  it("lists the one Task of a Study nothing has ever run in", async () => {
    const api = openStudy(ECO);
    // The premise: nothing here has been talked to at all, so nothing but its
    // Task list can put anything on the page.
    expect(
      (await api.getStudy(ECO)).tasks.every((t) => t.runCount === 0),
    ).toBe(true);
    const [only] = (await api.getStudy(ECO)).tasks;

    await screen.findByRole("region", { name: "All tasks" });
    expect(
      within(taskList()).getByText(only.title).closest("a"),
    ).toHaveAttribute("href", `#/studies/${ECO}/tasks/${only.id}`);
  });
});

/**
 * What the Study's own name row offers: pinning it to the top of the list,
 * and the three things you can do to the Study itself.
 */
describe("the Study's head actions", () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      await screen.findByRole("button", { name: "Study actions" }),
    );
  };

  it("pins the Study, and says so by offering to unpin it", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);

    await user.click(await screen.findByRole("button", { name: "Pin study" }));

    // The pin reached the Study, not just the button.
    await waitFor(async () =>
      expect((await api.getStudy(CMP)).study.pinned).toBe(true),
    );
    expect(
      await screen.findByRole("button", { name: "Unpin study" }),
    ).toBeInTheDocument();
  });

  it("unpins a Study that was pinned", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    await api.updateStudy(CMP, { pinned: true });
    openStudy(CMP, api);

    await user.click(
      await screen.findByRole("button", { name: "Unpin study" }),
    );
    await waitFor(async () =>
      expect("pinned" in (await api.getStudy(CMP)).study).toBe(false),
    );
  });

  it("offers edit, archive and delete behind the one menu", async () => {
    const user = userEvent.setup();
    openStudy(CMP);
    await openMenu(user);

    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Edit/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Archive/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Delete/ })).toBeInTheDocument();
  });

  it("edits every field of the Study through the same form that opens one", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /Edit/ }));

    const dialog = await screen.findByRole("dialog", { name: "Edit study" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Renamed line");
    await user.clear(within(dialog).getByLabelText("Description"));
    await user.type(within(dialog).getByLabelText("Description"), "A new brief.");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      const { study } = await api.getStudy(CMP);
      expect(study.title).toBe("Renamed line");
      expect(study.description).toBe("A new brief.");
    });
    // The page it was edited from shows the edit.
    expect(
      await screen.findByRole("heading", { name: "Renamed line", level: 1 }),
    ).toBeInTheDocument();
  });

  it("archives the Study without throwing you off its page, and offers to restore it", async () => {
    // `getStudy` still resolves for an archived Study, so ejecting the reader
    // would contradict the contract. It only leaves the list.
    const user = userEvent.setup();
    const api = openStudy(CMP);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /Archive/ }));

    await waitFor(async () =>
      expect((await api.getStudy(CMP)).study.archivedTs).toBeDefined(),
    );
    expect(window.location.hash).toBe(`#/studies/${CMP}`);

    await openMenu(user);
    expect(
      screen.getByRole("menuitem", { name: /Restore/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Archive/ })).toBeNull();
  });

  it("deletes the Study behind a confirmation, then lands on the list it left", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /Delete/ }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Delete/ }));

    await waitFor(() => expect(window.location.hash).toBe("#/studies"));
    await expect(api.getStudy(CMP)).rejects.toThrow();
  });
});

describe("the chat the Study ships", () => {
  it("shows the transcript on the Task that holds it", async () => {
    const api = createInMemoryApi();
    const seeded = await api.getTask("t_3");
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={api} />);

    await screen.findByTestId("task-surface");
    // The Task IS the conversation, so its own page replays the turns — there
    // is no second record to open and nothing to link it to.
    const thread = await screen.findByTestId("conversation");
    expect(
      await within(thread).findByText(seeded.turns[0].prompt),
    ).toBeInTheDocument();
    expect(
      within(thread).getByText(seeded.turns[1].prompt),
    ).toBeInTheDocument();
  });

  it("names the open Task in the tab bar", async () => {
    const api = createInMemoryApi();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={api} />);

    await screen.findByTestId("task-surface");
    expect(
      await screen.findByText(/CMP-3: Preprocess two-photon calcium traces/i),
    ).toBeInTheDocument();
  });

  it("lists the Study's other Tasks in the rail, and opens one", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={api} />);

    await screen.findByTestId("task-surface");
    const rail = screen.getByTestId("context-rail");
    const other = (await api.getStudy(CMP)).tasks.find((t) => t.id === "t_4")!;
    await user.click(await within(rail).findByText(other.title));

    await waitFor(() =>
      expect(window.location.hash).toBe(`#/studies/${CMP}/tasks/t_4`),
    );
  });

  it("mints another Task from the rail's New", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const before = (await api.getStudy(CMP)).tasks.length;
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={api} />);

    await screen.findByTestId("task-surface");
    const rail = screen.getByTestId("context-rail");
    await user.click(within(rail).getByRole("button", { name: "New" }));

    // A new chat in this Study is a new Task in it — one act, one record.
    await waitFor(async () =>
      expect((await api.getStudy(CMP)).tasks.length).toBe(before + 1),
    );
  });
});

/**
 * The row menu the Study page's Task list carries: Pin · Rename · Move to
 * study · Delete. The same four the Task surface's sidebar offers, because a
 * Task row is a Task row wherever a reader meets one.
 */
describe("a Task row's actions on the Study page", () => {
  /** Open one row's kebab. */
  const openRowMenu = (
    user: ReturnType<typeof userEvent.setup>,
    title: string,
  ) =>
    user.click(
      screen.getByRole("button", { name: `Task actions for ${title}` }),
    );

  /** The Tasks the list is showing, top to bottom, by where each row points. */
  const rowOrder = () =>
    within(taskList())
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));

  it("leads each row with the mark of the coding agent that Task is talking to", async () => {
    // Which agent is on a piece of work is the fact that separates two rows
    // of this list, so the row wears it — the same brand marks the composer's
    // CLI dock wears, so one drawing means one agent everywhere on the page.
    const base = createInMemoryApi();
    const api: LykeionApi = {
      ...base,
      async getStudy(studyId) {
        const detail = await base.getStudy(studyId);
        return {
          ...detail,
          tasks: detail.tasks.map((t, i) => ({
            ...t,
            agent: ["claude", "cursor"][i % 2],
          })),
        };
      },
    };
    openStudy(CMP, api);
    const { tasks } = await api.getStudy(CMP);
    await screen.findByRole("region", { name: "All tasks" });

    const marks = [...taskList().querySelectorAll("[data-agent]")].map((el) =>
      el.getAttribute("data-agent"),
    );
    expect(marks).toEqual(tasks.map((t) => t.agent));
    // And the mark replaces the chat glyph rather than joining it.
    expect(taskList().querySelectorAll('svg[data-icon="chat"]')).toHaveLength(0);
  });

  it("keeps the chat glyph on a Task nobody has run, which is on no agent yet", async () => {
    // A Task is a chat before it is anything else, and the seeded lab's Tasks
    // have run on nothing a brand mark exists for — so every row here falls
    // back to the same glyph the rail's conversation control carries.
    const api = openStudy(CMP);
    const { tasks } = await api.getStudy(CMP);
    await screen.findByRole("region", { name: "All tasks" });

    expect(taskList().querySelectorAll("[data-agent]")).toHaveLength(0);
    expect(taskList().querySelectorAll('svg[data-icon="chat"]')).toHaveLength(
      tasks.length,
    );
  });

  it("pins a Task into a Pinned group of its own, under the composer", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const all = (await api.getStudy(CMP)).tasks;
    const last = all[all.length - 1];
    await screen.findByRole("region", { name: "All tasks" });

    // Nothing is pinned yet, so there is no group to head — an eyebrow over a
    // list nobody has pinned anything in is noise.
    expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull();

    await openRowMenu(user, last.title);
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));

    await waitFor(async () =>
      expect(
        (await api.getStudy(CMP)).tasks.find((t) => t.id === last.id)!.pinned,
      ).toBe(true),
    );

    // The pinned Task moves into its own group, which reads first.
    const group = await screen.findByRole("region", { name: "Pinned" });
    expect(
      within(group)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([rowHref(CMP, last.id)]);

    // What is left is no longer "all", and still reads in number order.
    const rest = screen.getByRole("region", { name: "Tasks" });
    expect(
      within(rest)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(all.slice(0, -1).map((t) => rowHref(CMP, t.id)));
  });

  it("takes the Pinned group away again when the last pin is lifted", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const all = (await api.getStudy(CMP)).tasks;
    await api.updateTask(all[0].id, { pinned: true });
    openStudy(CMP, api);

    await screen.findByRole("region", { name: "Pinned" });
    await openRowMenu(user, all[0].title);
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));

    // Back to one ungrouped list, holding every Task again.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Pinned" })).toBeNull(),
    );
    expect(rowOrder()).toEqual(all.map((t) => rowHref(CMP, t.id)));
  });

  it("renames a Task in place", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const first = (await api.getStudy(CMP)).tasks[0];
    await screen.findByRole("region", { name: "All tasks" });

    await openRowMenu(user, first.title);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    // The row becomes its own editor — no dialog opens over the list.
    const input = screen.getByRole("textbox", {
      name: `Rename ${first.title}`,
    });
    await user.clear(input);
    await user.type(input, "Model routing spike{Enter}");

    await waitFor(async () =>
      expect(
        (await api.getStudy(CMP)).tasks.find((t) => t.id === first.id)!.title,
      ).toBe("Model routing spike"),
    );
  });

  it("moves a Task to another Study, and it leaves this list", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const { study: eco } = await api.getStudy(ECO);
    const moved = (await api.getStudy(CMP)).tasks[0];
    await screen.findByRole("region", { name: "All tasks" });

    await openRowMenu(user, moved.title);
    await user.hover(screen.getByRole("menuitem", { name: /Move to study/ }));
    await user.click(
      screen.getByRole("menuitem", { name: new RegExp(eco.title) }),
    );

    // Filed under the other Study, and gone from this one — a Task has one
    // Study, so the move is a move and not a copy.
    await waitFor(async () =>
      expect(
        (await api.getStudy(ECO)).tasks.some((t) => t.id === moved.id),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(rowOrder()).not.toContain(rowHref(CMP, moved.id)),
    );
  });

  it("never offers to move a Task to the Study it is already in", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const { study } = await api.getStudy(CMP);
    const first = (await api.getStudy(CMP)).tasks[0];
    await screen.findByRole("region", { name: "All tasks" });

    await openRowMenu(user, first.title);
    await user.hover(screen.getByRole("menuitem", { name: /Move to study/ }));

    expect(
      screen.queryByRole("menuitem", { name: new RegExp(study.title) }),
    ).toBeNull();
  });

  it("asks before deleting a Task, and deletes nothing until it is answered", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const all = (await api.getStudy(CMP)).tasks;
    const doomed = all[0];
    await screen.findByRole("region", { name: "All tasks" });

    await openRowMenu(user, doomed.title);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(
      await screen.findByRole("dialog", { name: /delete task/i }),
    ).toBeInTheDocument();
    // The Task is still there — a Task is its chat, and there is no archive
    // to recover one from, so the click alone must not be enough.
    expect((await api.getStudy(CMP)).tasks.length).toBe(all.length);
  });

  it("leaves the Task alone when the confirmation is dismissed", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const all = (await api.getStudy(CMP)).tasks;
    const doomed = all[0];
    await screen.findByRole("region", { name: "All tasks" });

    await openRowMenu(user, doomed.title);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await screen.findByRole("dialog", { name: /delete task/i });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /delete task/i })).toBeNull(),
    );
    expect((await api.getStudy(CMP)).tasks.length).toBe(all.length);
    expect(rowOrder()).toContain(rowHref(CMP, doomed.id));
  });

  it("deletes a Task from the list once the confirmation is answered", async () => {
    const user = userEvent.setup();
    const api = openStudy(CMP);
    const all = (await api.getStudy(CMP)).tasks;
    const doomed = all[0];
    await screen.findByRole("region", { name: "All tasks" });

    await openRowMenu(user, doomed.title);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: /delete task/i });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(async () =>
      expect((await api.getStudy(CMP)).tasks.length).toBe(all.length - 1),
    );
    await waitFor(() =>
      expect(rowOrder()).not.toContain(rowHref(CMP, doomed.id)),
    );
  });
});
