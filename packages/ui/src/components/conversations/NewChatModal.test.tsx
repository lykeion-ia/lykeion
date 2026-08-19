/**
 * Starting a conversation.
 *
 * The modal is prompt-first but not subject-free: a thread is ABOUT a Task, so
 * the Research and the Task come before the message, and the people in it are
 * seeded from whoever that Task is on. Role/text-based, agnostic to markup.
 */

import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type Conversation } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { NewChatModal } from "./NewChatModal";

afterEach(cleanup);

function mount(onCreated?: (c: Conversation) => void) {
  const api = createInMemoryApi();
  render(
    <ApiProvider api={api}>
      <NewChatModal onClose={() => {}} onCreated={onCreated} />
    </ApiProvider>,
  );
  return api;
}

const startButton = () => screen.getByRole("button", { name: /Start chat/i });

it("will not start until it has a subject and something to say", async () => {
  const user = userEvent.setup();
  mount();

  // Nothing chosen, nothing written.
  expect(startButton()).toBeDisabled();

  // The Task picker has nothing to offer until a Research names some.
  expect(screen.getByRole("combobox", { name: "Task" })).toBeDisabled();

  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Research" }),
    within(screen.getByRole("combobox", { name: "Research" }))
      .getByText(/Cross-modal plasticity/i)
      .getAttribute("value")!,
  );
  // A Research alone is not a subject.
  expect(startButton()).toBeDisabled();

  const taskPicker = await screen.findByRole("combobox", { name: "Task" });
  await user.selectOptions(
    taskPicker,
    within(taskPicker)
      .getByText(/Preprocess two-photon calcium traces/i)
      .getAttribute("value")!,
  );
  // A subject with nothing said about it is still not a thread.
  expect(startButton()).toBeDisabled();

  await user.type(
    screen.getByRole("textbox", { name: "First message" }),
    "Does 512 hold up?",
  );
  expect(startButton()).toBeEnabled();
});

it("seeds the people from the Task, and re-seeds when the subject changes", async () => {
  const user = userEvent.setup();
  mount();

  const studyPicker = await screen.findByRole("combobox", { name: "Research" });
  await user.selectOptions(
    studyPicker,
    within(studyPicker)
      .getByText(/Cross-modal plasticity/i)
      .getAttribute("value")!,
  );

  const taskPicker = await screen.findByRole("combobox", { name: "Task" });
  // CMP-3 is on You.
  await user.selectOptions(
    taskPicker,
    within(taskPicker)
      .getByText(/Preprocess two-photon calcium traces/i)
      .getAttribute("value")!,
  );
  expect(
    await screen.findByRole("button", { name: "Remove You" }),
  ).toBeInTheDocument();

  // CMP-4 is on Amara. Changing the subject moves the people with it — a
  // thread seeded from one Task that kept its people after the subject moved
  // would be wrong, not preserved.
  await user.selectOptions(
    taskPicker,
    within(taskPicker)
      .getByText(/Register sessions across days/i)
      .getAttribute("value")!,
  );
  expect(
    await screen.findByRole("button", { name: "Remove Amara" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Remove You" }),
  ).not.toBeInTheDocument();
});

it("takes the Task's title when none is given, and posts the opening message", async () => {
  const user = userEvent.setup();
  let created: Conversation | undefined;
  const api = mount((c) => (created = c));

  const studyPicker = await screen.findByRole("combobox", { name: "Research" });
  await user.selectOptions(
    studyPicker,
    within(studyPicker)
      .getByText(/Cross-modal plasticity/i)
      .getAttribute("value")!,
  );
  const taskPicker = await screen.findByRole("combobox", { name: "Task" });
  await user.selectOptions(
    taskPicker,
    within(taskPicker)
      .getByText(/Register sessions across days/i)
      .getAttribute("value")!,
  );
  await user.type(
    screen.getByRole("textbox", { name: "First message" }),
    "Are the offsets on disk?",
  );
  await user.click(startButton());

  expect(created).toBeDefined();
  expect(created!.title).toBe("Register sessions across days");

  const detail = await api.getConversation(created!.id);
  expect(detail.messages.map((m) => m.body)).toEqual([
    "Are the offsets on disk?",
  ]);

  // The opener is in the thread they opened, alongside the Task's own people.
  const me = await api.currentUser();
  expect(
    created!.participants.some((p) => p.kind === "user" && p.userId === me.id),
  ).toBe(true);
  expect(
    created!.participants.some(
      (p) => p.kind === "user" && p.userId !== me.id,
    ),
  ).toBe(true);
});

it("a written title wins over the Task's", async () => {
  const user = userEvent.setup();
  let created: Conversation | undefined;
  mount((c) => (created = c));

  const studyPicker = await screen.findByRole("combobox", { name: "Research" });
  await user.selectOptions(
    studyPicker,
    within(studyPicker)
      .getByText(/Cross-modal plasticity/i)
      .getAttribute("value")!,
  );
  const taskPicker = await screen.findByRole("combobox", { name: "Task" });
  await user.selectOptions(
    taskPicker,
    within(taskPicker)
      .getByText(/Preprocess two-photon calcium traces/i)
      .getAttribute("value")!,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Chat title" }),
    "The 512 problem",
  );
  await user.type(
    screen.getByRole("textbox", { name: "First message" }),
    "Where did 512 come from?",
  );
  await user.click(startButton());

  expect(created!.title).toBe("The 512 problem");
});
