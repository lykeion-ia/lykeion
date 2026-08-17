/**
 * Filing an unfiled Task from the composer.
 *
 * An unfiled Task belongs to the Lab rather than to a research line, so it has
 * no workspace to run in. Rather than disabling the composer, the FIRST send
 * asks which Study and files the Task on the way: filing stops being a
 * precondition the researcher has to satisfy before working and becomes a step
 * inside the work. Cancelling abandons that send and leaves the draft alone.
 * Role/text-based, agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type LykeionApi } from "@lykeion/api";
import App from "../App";
import { resetPageLoad } from "../lib/tabs-storage";
import { resetTabs } from "../lib/tabs";

// t_13 is seeded unfiled — it belongs to no Study, which is the whole premise.
const UNFILED = "t_13";
const ROUTE = `#/studies/s_cmp/tasks/${UNFILED}`;

/** The in-memory API, wrapped to count `startRun` calls. */
function countingApi(): { api: LykeionApi; starts: () => number } {
  const inner = createInMemoryApi();
  let starts = 0;
  const api: LykeionApi = {
    ...inner,
    startRun: (input) => {
      starts += 1;
      return inner.startRun(input);
    },
  };
  return { api, starts: () => starts };
}

beforeEach(() => {
  cleanup();
  // The strip is a module store now, so a test would otherwise inherit
  // whichever route (and whichever tab) the previous test's navigation and
  // filing left behind, rather than starting from a single Studies tab the
  // way each of these assumes.
  resetTabs();
  window.location.hash = "";
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});

describe("the first send on an unfiled Task", () => {
  it("asks which Study, files the Task, and runs the prompt there", async () => {
    const user = userEvent.setup();
    const { api, starts } = countingApi();
    const cmp = (await api.listStudies()).find((s) => s.key === "CMP")!;
    // The premise: this Task has no Study, so nothing could run it as it is.
    expect((await api.getTask(UNFILED)).task.studyId).toBeUndefined();
    const numberBefore = (await api.getTask(UNFILED)).task.number;

    window.location.hash = ROUTE;
    render(<App api={api} />);

    // The composer is live, not disabled — the question comes on send.
    await user.type(
      await screen.findByLabelText("Message the agent"),
      "chase the drift",
    );
    expect(starts()).toBe(0);
    await user.click(screen.getByRole("button", { name: "Send" }));

    // Nothing has run yet: the send is waiting on one question.
    expect(starts()).toBe(0);
    await user.selectOptions(
      await screen.findByLabelText(/file it to run it/i),
      cmp.id,
    );
    await user.click(screen.getByRole("button", { name: "File and send" }));

    // The Task is filed and the held-back prompt ran in its new Study.
    await waitFor(async () =>
      expect((await api.getTask(UNFILED)).task.studyId).toBe(cmp.id),
    );
    await waitFor(() => expect(starts()).toBe(1));

    // Filing keeps the number, so only the Study half of its code changes.
    expect((await api.getTask(UNFILED)).task.number).toBe(numberBefore);
  });

  it("runs the send in the Study picked, not the one the address named", async () => {
    const user = userEvent.setup();
    const { api } = countingApi();
    // Deliberately a DIFFERENT Study from the one in the route: filing moves
    // the Task out from under the address it was opened at, and the turn has
    // to start in the workspace it was actually filed into.
    const eco = (await api.listStudies()).find((s) => s.key === "ECO")!;
    const runStudies: string[] = [];
    const spied: LykeionApi = {
      ...api,
      // Records where each turn was started; still drives the real run.
      startRun: (input) => {
        runStudies.push(input.studyId);
        return api.startRun(input);
      },
    };

    window.location.hash = ROUTE;
    render(<App api={spied} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "chase the drift",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.selectOptions(
      await screen.findByLabelText(/file it to run it/i),
      eco.id,
    );
    await user.click(screen.getByRole("button", { name: "File and send" }));

    // The parked send survives the address changing under it — moving Study is
    // the very thing it was waiting for, so it must not read as leaving.
    await waitFor(() => expect(runStudies).toEqual([eco.id]));
    expect((await api.getTask(UNFILED)).task.studyId).toBe(eco.id);
  });

  it("abandons the send on cancel, leaving the draft where it was", async () => {
    const user = userEvent.setup();
    const { api, starts } = countingApi();
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const composer = (await screen.findByLabelText(
      "Message the agent",
    )) as HTMLTextAreaElement;
    await user.type(composer, "chase the drift");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    // Nothing ran, nothing was filed, and the message is still there to send
    // again — a cancelled question must not cost the researcher their text.
    expect(starts()).toBe(0);
    expect((await api.getTask(UNFILED)).task.studyId).toBeUndefined();
    expect(composer.value).toBe("chase the drift");
  });

  it("opens the conversation at the unfiled address, and files it from there", async () => {
    const user = userEvent.setup();
    const { api, starts } = countingApi();
    const cmp = (await api.listStudies()).find((s) => s.key === "CMP")!;
    const title = (await api.getTask(UNFILED)).task.title;
    // The Task's OWN address — no Study in it, because it has none. This is
    // where every list in the Lab sends an unfiled Task.
    window.location.hash = `#/tasks/${UNFILED}`;
    render(<App api={api} />);

    // The same surface a filed Task opens: a live composer, not a details
    // form. A chat nobody can speak in is not a chat.
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    await user.type(
      await screen.findByLabelText("Message the agent"),
      "chase the drift",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.selectOptions(
      await screen.findByLabelText(/file it to run it/i),
      cmp.id,
    );
    await user.click(screen.getByRole("button", { name: "File and send" }));

    await waitFor(async () =>
      expect((await api.getTask(UNFILED)).task.studyId).toBe(cmp.id),
    );
    await waitFor(() => expect(starts()).toBe(1));

    // The breadcrumb follows the Task across the move. Filing changes which
    // Study's tab strip this conversation belongs to, and a tab left on the
    // unfiled strip would vanish the moment the address caught up.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: title, pressed: true }),
      ).toBeInTheDocument(),
    );
  });

  it("asks only once — a filed Task sends straight away", async () => {
    const user = userEvent.setup();
    const { api, starts } = countingApi();
    // A Task that already has a Study is the same surface, minus the question.
    window.location.hash = "#/studies/s_cmp/tasks/t_5";
    render(<App api={api} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "analyze the traces",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(starts()).toBe(1));
    expect(
      screen.queryByRole("button", { name: "File and send" }),
    ).toBeNull();
  });
});
