import { afterEach, beforeEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";
import { captureDownload } from "../test/download";
import { resetTabs } from "../lib/tabs";

beforeEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  // The strip is a module store now, so a test that renders `<App>` without
  // setting its own hash would otherwise inherit whichever route the last
  // test's navigation left the active tab on.
  resetTabs();
  window.location.hash = "";
});
afterEach(cleanup);

it("My Tasks shows the status board with an assigned task, and toggles to list", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /My Tasks/i }));

  // Board columns + a real myWork task (t_6, todo, assignee "you").
  expect(
    await screen.findByText("Quantify tuning drift after deprivation"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("In Progress").length).toBeGreaterThan(0);

  // Toggle to the list view.
  await user.click(screen.getByRole("button", { name: /List view/i }));
  expect(
    screen.getByText("Quantify tuning drift after deprivation"),
  ).toBeInTheDocument();
});

it("My Tasks shows an unfiled task assigned to me", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const me = await api.currentUser();
  const loose = await api.createTask({
    stage: "background",
    title: "Book the confocal before the grant deadline",
    assignees: [{ kind: "user", userId: me.id }],
  });
  expect(loose.studyId).toBeUndefined();

  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /My Tasks/i }));

  // A task with no Study resolves to no row in the study lookup. Rendering
  // that as nothing would take assigned work off my own queue.
  expect(
    await screen.findByText("Book the confocal before the grant deadline"),
  ).toBeInTheDocument();
});

it("My Tasks keeps the work of an archived study", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  const cmp = (await api.listStudies()).find((s) => s.key === "CMP")!;
  await api.archiveStudy(cmp.id);

  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /My Tasks/i }));

  // Archiving takes the Study out of the Studies list; the unfinished work
  // assigned to me is still mine to do.
  expect(
    await screen.findByText("Quantify tuning drift after deprivation"),
  ).toBeInTheDocument();
});

it("My Tasks empty state on a fresh install", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /My Tasks/i }));
  expect(
    await screen.findByText(/Nothing assigned to you yet/i),
  ).toBeInTheDocument();
});

it("My Tasks exports what is on my board, under its own name", async () => {
  const download = captureDownload();
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /My Tasks/i }));
  await screen.findByText("Quantify tuning drift after deprivation");

  await user.click(screen.getByRole("button", { name: /Import \/ Export/i }));
  await user.click(
    await screen.findByRole("menuitem", { name: /Export as JSON/i }),
  );

  // Both boards offer the same menu; each still exports its own board, to its
  // own file, so one download cannot overwrite the other.
  const saved = await download.saved();
  const titles = saved.doc.tasks.map((t: { title: string }) => t.title);
  expect(titles).toContain("Quantify tuning drift after deprivation");
  expect(titles).not.toContain("Register sessions across days"); // Amara's
  expect(saved.name).toBe("my-tasks.json");
});

it("the Rail 'New Task' button opens the create-task modal", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await screen.findByText("Cross-modal plasticity in the brain");
  await user.click(screen.getByRole("button", { name: /New Task/i }));
  const dialog = await screen.findByRole("dialog", { name: /Create task/i });
  expect(dialog).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("dialog", { name: /Create task/i }),
  ).not.toBeInTheDocument();
});
