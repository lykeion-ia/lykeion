import { afterEach, beforeEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";
import { resetPageLoad } from "../lib/tabs-storage";
import { resetTabs } from "../lib/tabs";
import { captureDownload } from "../test/download";

// Seeded work, by whose it is: t_4 is Amara's, everything else in CMP is
// mine, and t_8 lives in a different Study.
const AMARAS = "Register sessions across days";
const MINE = "Quantify tuning drift after deprivation";
const OTHER_STUDY = "Integrate 10x lanes and remove batch effects";
const DONE = "Survey cross-modal plasticity literature";
const UNFILED = "Chase the reviewer's point about spike sorting drift";

beforeEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  window.location.hash = "";
  resetTabs();
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});
afterEach(cleanup);

/** Open Tasks the way a researcher does — through the Rail. */
async function openTasks(api = createInMemoryApi()) {
  const user = userEvent.setup();
  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /^Tasks$/i }));
  return user;
}

it("lists work from every Study, not just the one in view", async () => {
  await openTasks();
  expect(await screen.findByText(MINE)).toBeInTheDocument();
  expect(screen.getByText(OTHER_STUDY)).toBeInTheDocument();
});

it("shows other people's tasks, which is what separates it from My Tasks", async () => {
  const user = await openTasks();
  const amaras = await screen.findByText(AMARAS);
  expect(amaras).toBeInTheDocument();

  // The same task is absent from My Tasks: it is not assigned to me.
  await user.click(screen.getByRole("link", { name: /My Tasks/i }));
  expect(await screen.findByText(MINE)).toBeInTheDocument();
  expect(screen.queryByText(AMARAS)).not.toBeInTheDocument();
});

it("shows finished work, and the Status filter takes it away again", async () => {
  const user = await openTasks();
  // A done task is part of the Lab's record — `listTasks({ includeDone })`.
  expect(await screen.findByText(DONE)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /^Filter$/i }));
  await user.click(await screen.findByRole("button", { name: /^Status/i }));
  await user.click(await screen.findByRole("button", { name: /^Todo/i }));

  expect(screen.queryByText(DONE)).not.toBeInTheDocument();
  expect(screen.getByText(MINE)).toBeInTheDocument();
});

it("keeps the tasks of an archived Study", async () => {
  const api = createInMemoryApi();
  const cmp = (await api.listStudies()).find((s) => s.key === "CMP")!;
  await api.archiveStudy(cmp.id);

  await openTasks(api);

  // Archiving tidies the Studies list; it does not finish the work. A row
  // whose Study is missing from the lookup would silently disappear.
  expect(await screen.findByText(MINE)).toBeInTheDocument();
});

it("shows an unfiled task with its own code and no Study", async () => {
  const user = await openTasks();
  // The Study cell is the list's column, so this is asked of the list.
  await user.click(screen.getByRole("button", { name: "List view" }));
  const title = await screen.findByText(UNFILED);
  const row = title.closest("a")!;

  // Unfiled work numbers on its own run, so it reads TSK-n rather than
  // borrowing a Study's key, and its Study cell says so.
  expect(within(row).getByText("TSK-1")).toBeInTheDocument();
  expect(within(row).getByText("Unfiled")).toBeInTheDocument();
});

it("deep-links an unfiled task straight to its chat", async () => {
  const api = createInMemoryApi();
  const unfiled = (await api.listTasks()).find((t) => t.title === UNFILED)!;
  window.location.hash = `#/tasks/${unfiled.id}`;

  render(<App api={api} />);

  // A Task is a chat whether or not it has been filed, so `#/tasks/<id>` opens
  // the conversation — with a live composer, since the first send is where
  // filing is asked about rather than a precondition for speaking at all.
  expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
  expect(await screen.findByLabelText("Message the agent")).toBeEnabled();
});

it("files an unfiled task into a Study from its details", async () => {
  const api = createInMemoryApi();
  const unfiled = (await api.listTasks()).find((t) => t.title === UNFILED)!;
  const cmp = (await api.listStudies()).find((s) => s.key === "CMP")!;

  const user = await openTasks(api);
  // The details editor is the work-item view of a Task — every field at once,
  // Study included. It hangs off the board card, so filing can happen without
  // opening the conversation.
  await user.click(screen.getByRole("button", { name: "Board view" }));
  const card = (await screen.findByText(UNFILED)).closest("a")!;
  await user.click(
    within(card).getByRole("button", { name: "Edit task details" }),
  );

  const dialog = await screen.findByRole("dialog", { name: "Task details" });
  await user.selectOptions(
    within(dialog).getByRole("combobox", { name: /file into a study/i }),
    cmp.id,
  );
  await user.click(within(dialog).getByRole("button", { name: /^save$/i }));

  // Filing is what gives the task a home — and a workspace to run in.
  const filed = (await api.getStudy(cmp.id)).tasks.find(
    (t) => t.id === unfiled.id,
  );
  expect(filed).toBeDefined();
});

it("narrows to one researcher through the Assignee filter", async () => {
  const user = await openTasks();
  expect(await screen.findByText(AMARAS)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /^Filter$/i }));
  await user.click(await screen.findByRole("button", { name: /^Assignee/i }));
  // The option's accessible name leads with its avatar initial ("AAmara2"),
  // so this cannot be anchored.
  await user.click(await screen.findByRole("button", { name: /Amara/i }));

  expect(screen.getByText(AMARAS)).toBeInTheDocument();
  expect(screen.queryByText(MINE)).not.toBeInTheDocument();
});

it("exports the tasks in view — the whole Lab's work, not just mine", async () => {
  const download = captureDownload();
  const user = await openTasks();
  await screen.findByText(MINE);
  await user.click(screen.getByRole("button", { name: /Import \/ Export/i }));
  await user.click(
    await screen.findByRole("menuitem", { name: /Export as JSON/i }),
  );

  const saved = await download.saved();
  const titles = saved.doc.tasks.map((t: { title: string }) => t.title);
  expect(titles).toContain(MINE);
  expect(titles).toContain(AMARAS);
  // Not "my-tasks.json": this board holds more than My Tasks does, and the two
  // documents should not overwrite each other in a downloads folder.
  expect(saved.name).toBe("tasks.json");
  expect(await screen.findByText(/Exported \d+ task\(s\)\./)).toBeVisible();
});

it("imports tasks from a JSON file", async () => {
  const user = await openTasks(createInMemoryApi(emptySeed()));
  await screen.findByText(/No tasks in the lab yet/i);

  const doc = JSON.stringify({
    kind: "lykeion.tasks",
    version: 1,
    tasks: [
      {
        stage: "background",
        title: "Reread the drift-correction paper",
        status: "todo",
        priority: "none",
      },
    ],
  });
  await user.upload(
    document.querySelector<HTMLInputElement>('input[type="file"]')!,
    new File([doc], "tasks.json", { type: "application/json" }),
  );

  // A row with no studyId lands as unfiled, and Tasks is the surface that
  // shows unfiled work — so what was imported is visible where it was asked for.
  expect(
    await screen.findByText("Reread the drift-correction paper"),
  ).toBeInTheDocument();
  expect(screen.getByText(/Imported 1 task\(s\)\./)).toBeVisible();
});

it("renders the empty state on a fresh install", async () => {
  await openTasks(createInMemoryApi(emptySeed()));
  expect(
    await screen.findByText(
      /No tasks in the lab yet — create one to get started\./i,
    ),
  ).toBeInTheDocument();
});
