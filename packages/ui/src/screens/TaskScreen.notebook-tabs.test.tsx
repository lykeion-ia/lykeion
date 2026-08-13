/**
 * The inspector's notebook breadcrumb.
 *
 * A notebook belongs to a Task, but it is read against a Study: the Tasks of
 * one Study share a workspace, and what one of them ran is the context for what
 * the next one runs. So the pane accumulates the notebooks opened in the Study
 * and survives the click from one Task to another.
 *
 * The strip is the record of what was OPENED, and nothing else. A Task you are
 * merely standing on has no tab until you open its notebook, and once it has
 * one it is a tab like any other — same label, same tooltip, same close. The
 * alternative, a tab for the current Task drawn whether or not it was ever
 * opened, made the strip reorder itself under the reader: arriving anywhere put
 * a notebook nobody had opened in first place and pushed the one being read to
 * second, which is indistinguishable from having lost it.
 *
 * The one thing it will NOT do is pair a mismatched screen. A notebook is the
 * record of what one conversation ran, so the pane always shows THIS Task's,
 * and reaching another Task's notebook means going to that Task — the ledger
 * and the transcript arrive together, and the pane keeps its place so the
 * notebook is what you land on.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type { LykeionApi, NotebookCell } from "@lykeion/api";
import App from "../App";
import { closeNotebookTab } from "../lib/notebook-tabs";
import { closeTaskTab } from "../lib/task-tabs";

/** Two Tasks of the seeded Study, by the titles the fixture gives them. */
const TASK_A = { id: "t_3", title: "Preprocess two-photon calcium traces" };
const TASK_B = { id: "t_5", title: "Fit orientation tuning curves per neuron" };

const cell = (taskId: string): NotebookCell => ({
  id: `cell_${taskId}`,
  kernelId: `k_${taskId}`,
  name: "main",
  language: "python",
  environment: "python",
  executionCount: 1,
  source: "1 + 1",
  origin: { surface: "agent", by: "claude" },
  ok: true,
  wallMs: 4,
  ts: 1,
  outputs: [{ kind: "stream", name: "stdout", text: "2\n" }],
});

/** Every Task has a notebook of its own, and no kernel is still holding one —
 *  a ledger is readable long after the namespace that wrote it has gone. */
const apiWithNotebooks = (): LykeionApi => ({
  ...createInMemoryApi(),
  taskNotebook: async (taskId: string) => [cell(taskId)],
  listRunningKernels: async () => [],
});

/** Which notebook the pane is showing — the panel names its own session. */
const shownNotebook = () =>
  within(screen.getByTestId("notebook-panel")).getByTestId(
    "notebook-session-label",
  ).textContent;

/**
 * The strip's entry for a Task's notebook. Every notebook tab is labelled
 * `Notebook`, so the tooltip is what addresses one of them — which is exactly
 * how a reader tells them apart on screen.
 */
const notebookTab = (title: string) =>
  screen.queryByTitle(`Notebook — ${title}`);

/** The notebooks on the strip, in the order it draws them. `Files` carries no
 *  tooltip, which is what drops it here. */
const notebookOrder = () =>
  within(screen.getByTestId("rightpane-tab-band"))
    .getAllByRole("tab")
    .map((t) => t.getAttribute("title"))
    .filter((t): t is string => t !== null);

/** Which conversation the surface is on — the marked tab of the crumb strip. */
const currentConversation = () =>
  within(screen.getByTestId("task-tab-band"))
    .getAllByRole("button", { pressed: true })[0]
    ?.textContent;

beforeEach(() => {
  window.location.hash = `#/studies/s_cmp/tasks/${TASK_A.id}`;
});

afterEach(() => {
  cleanup();
  // Module-singleton stores, and there is no reset export for either.
  closeNotebookTab(TASK_A.id);
  closeNotebookTab(TASK_B.id);
  closeTaskTab(TASK_A.id);
  closeTaskTab(TASK_B.id);
});

/**
 * Move to another Task from the sidebar. Scoped to the rail on purpose: once a
 * Task has been visited it also has a conversation crumb tab of the same name,
 * and an unscoped query would not know which of the two it meant.
 */
async function goToTask(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  const rail = within(screen.getByTestId("context-rail"));
  await user.click(await rail.findByRole("button", { name: title }));
}

/** Open the inspector. It closes on every Task change, so this is how any test
 *  that has navigated gets the strip back. */
async function openPane(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Toggle files panel" }),
  );
  await screen.findByTestId("artifacts-panel");
}

/**
 * Open this Task's notebook the way the surface offers it — the composer's
 * button. There is no tab to click until this has been done, which is the whole
 * of what makes the strip a record of what was opened.
 */
async function openNotebook(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: "Open notebook" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await screen.findByTestId("notebook-panel");
}

it("takes the conversation along when another Task's notebook is opened", async () => {
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);
  await waitFor(() => expect(shownNotebook()).toBe(TASK_A.title));

  // Move to another Task in the same Study, from the sidebar, and open the
  // inspector there — it closed on the way, as it does on every Task change.
  await goToTask(user, TASK_B.title);
  await openPane(user);

  // Task A's notebook is on the strip. It is labelled `Notebook`, like every
  // notebook tab — its tooltip is what says which one it is.
  await waitFor(() => expect(notebookTab(TASK_A.title)).toBeInTheDocument());
  expect(notebookTab(TASK_A.title)).toHaveTextContent("Notebook");

  await user.click(notebookTab(TASK_A.title)!);

  // A's ledger — and A's conversation with it. A notebook is the record of what
  // one conversation ran, so the two are never shown out of step: the pane does
  // not pull A's ledger over B's transcript, it goes to A.
  await waitFor(() => expect(window.location.hash).toContain(TASK_A.id));
  await waitFor(() => expect(shownNotebook()).toBe(TASK_A.title));
  expect(currentConversation()).toBe(TASK_A.title);

  // And the pane kept its place through the move, so the notebook is what the
  // reader lands on rather than something to open again.
  expect(screen.getByTestId("notebook-panel")).toBeInTheDocument();
});

it("does not carry the inspector into a Task you opened", async () => {
  // Opening a Task is a request to read the CONVERSATION. A pane that came
  // along — still open, still on whatever the last Task was showing — is the
  // surface deciding what this Task is about, and the reader never asked.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);
  await waitFor(() => expect(shownNotebook()).toBe(TASK_A.title));

  await goToTask(user, TASK_B.title);

  // The conversation, and nothing else.
  await waitFor(() => expect(screen.getByTestId("conversation")).toBeInTheDocument());
  expect(screen.queryByTestId("notebook-panel")).toBeNull();
  expect(screen.queryByTestId("artifacts-panel")).toBeNull();

  // Opened deliberately, it comes back on Files rather than on the notebook the
  // last Task was showing.
  await openPane(user);
  expect(screen.queryByTestId("notebook-panel")).toBeNull();
});

it("gives a Task no notebook tab until its notebook is opened", async () => {
  // Standing on a Task is not reading its ledger. Drawing a tab for it anyway
  // put a notebook nobody had opened at the head of the strip and moved the one
  // being read down a place, which is how a reader loses track of which of two
  // tabs called `Notebook` is theirs.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);
  await goToTask(user, TASK_B.title);
  await openPane(user);

  // A's notebook is here because it was opened. B's is not, though B is the
  // Task on screen and its notebook is one click away.
  await waitFor(() => expect(notebookTab(TASK_A.title)).toBeInTheDocument());
  expect(notebookTab(TASK_B.title)).toBeNull();
  expect(notebookOrder()).toEqual([`Notebook — ${TASK_A.title}`]);
});

it("lists the notebooks asked for, not the Tasks passed through", async () => {
  // A Task the reader merely walked to never showed its notebook, so it has not
  // earned a place on the strip.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);
  await goToTask(user, TASK_B.title);
  await goToTask(user, TASK_A.title);
  await openPane(user);

  // A's own notebook tab is there because A's notebook was opened; B's is not —
  // B was passed through, and its ledger was never on screen.
  await waitFor(() => expect(notebookTab(TASK_A.title)).toBeInTheDocument());
  expect(notebookTab(TASK_B.title)).toBeNull();
});

it("keeps the strip in the order the notebooks were opened", async () => {
  // The order is the reader's, not the router's. A strip that promoted whichever
  // notebook belonged to the Task on screen reshuffled itself on every move, so
  // the tab under the pointer was not the one that had been there a moment ago.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);
  await goToTask(user, TASK_B.title);
  await openNotebook(user);

  // B's notebook is the one on screen, and it is still second: A was opened
  // first and keeps the place it was given.
  await waitFor(() => expect(notebookTab(TASK_B.title)).toBeInTheDocument());
  expect(notebookOrder()).toEqual([
    `Notebook — ${TASK_A.title}`,
    `Notebook — ${TASK_B.title}`,
  ]);

  // Back to A, and the order is unchanged by the visit.
  await user.click(notebookTab(TASK_A.title)!);
  await waitFor(() => expect(window.location.hash).toContain(TASK_A.id));
  expect(notebookOrder()).toEqual([
    `Notebook — ${TASK_A.title}`,
    `Notebook — ${TASK_B.title}`,
  ]);
});

it("closes another Task's notebook without disturbing this one", async () => {
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);
  await goToTask(user, TASK_B.title);
  await openPane(user);
  await waitFor(() => expect(notebookTab(TASK_A.title)).toBeInTheDocument());

  // Named after its Task, and said as "notebook": the conversation's own strip
  // carries a close for that same Task, and the two do different things.
  await user.click(
    await screen.findByRole("button", {
      name: `Close notebook ${TASK_A.title}`,
    }),
  );

  // Off the strip, and nothing moved — closing a way back to another Task's
  // ledger costs this screen nothing. B's own notebook was never opened, so the
  // strip is left with no notebooks at all rather than with one it invented.
  await waitFor(() => expect(notebookTab(TASK_A.title)).toBeNull());
  expect(window.location.hash).toContain(TASK_B.id);
  expect(screen.queryAllByRole("tab", { name: "Notebook" })).toHaveLength(0);
});

it("gives this Task's own notebook a close, like every other", async () => {
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);

  // Once it is on the strip it is a tab, and a tab can be put away — every one
  // of them, with nothing on this strip exempt.
  await waitFor(() => expect(notebookTab(TASK_A.title)).toBeInTheDocument());
  expect(
    screen.getByRole("button", { name: `Close notebook ${TASK_A.title}` }),
  ).toBeInTheDocument();
});

it("opens the inspector on the notebook alone, with no Files beside it", async () => {
  // `Files` is not where the pane lives any more. It is a surface opened
  // deliberately, like the notebooks, and opening a notebook did not ask for it.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openNotebook(user);

  await waitFor(() => expect(notebookTab(TASK_A.title)).toBeInTheDocument());
  expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
  expect(screen.queryByTestId("artifacts-panel")).toBeNull();
});

it("hands the pane to the neighbouring tab when the notebook being read is closed", async () => {
  // Closing the tab of the notebook on screen has to take the panel with it, or
  // the pane goes on showing a ledger that nothing in the strip still names.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openPane(user);
  await openNotebook(user);
  await waitFor(() => expect(shownNotebook()).toBe(TASK_A.title));

  await user.click(
    screen.getByRole("button", { name: `Close notebook ${TASK_A.title}` }),
  );

  // Files was its neighbour on the strip, so Files is what the pane falls to.
  // Putting a tab away is not putting the inspector away.
  await waitFor(() => expect(screen.queryByTestId("notebook-panel")).toBeNull());
  expect(screen.getByTestId("artifacts-panel")).toBeInTheDocument();
  expect(notebookTab(TASK_A.title)).toBeNull();
  expect(window.location.hash).toContain(TASK_A.id);
});

it("closes Files without putting the inspector away, when a notebook is open too", async () => {
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openPane(user);
  await openNotebook(user);
  await user.click(screen.getByRole("tab", { name: "Files" }));
  await screen.findByTestId("artifacts-panel");

  await user.click(screen.getByRole("button", { name: "Close Files" }));

  // Off the strip, and the pane hands itself to the tab next to it rather than
  // going anywhere: there is still something open in there to read.
  await waitFor(() =>
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull(),
  );
  expect(await screen.findByTestId("notebook-panel")).toBeInTheDocument();
  expect(screen.queryByTestId("artifacts-panel")).toBeNull();
});

it("closes the inspector when its last tab is closed", async () => {
  // The pane IS its tabs. One with an empty strip names nothing, so the last
  // close takes the whole column with it.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openPane(user);
  await user.click(screen.getByRole("button", { name: "Close Files" }));

  await waitFor(() =>
    expect(screen.queryByTestId("rightpane-tab-band")).toBeNull(),
  );
  expect(screen.queryByTestId("artifacts-panel")).toBeNull();
  expect(screen.getByTestId("conversation")).toBeInTheDocument();
});

it("opens Files again from the toggle, once it has been closed", async () => {
  // Closing it is not dismissing it for good — the toggle is what opens the
  // inspector, and Files is what it opens.
  const user = userEvent.setup();
  render(<App api={apiWithNotebooks()} />);

  await openPane(user);
  await user.click(screen.getByRole("button", { name: "Close Files" }));
  await waitFor(() => expect(screen.queryByTestId("artifacts-panel")).toBeNull());

  await openPane(user);

  expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Close Files" }),
  ).toBeInTheDocument();
});
