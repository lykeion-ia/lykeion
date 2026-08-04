/**
 * The clarifying-question flow, end to end through the in-memory API: a prompt
 * containing "clarify" triggers the scripted question (memory.ts), the
 * QuestionCard renders it, and answering it resumes the turn — proven by the
 * permission card that follows only once the answer is delivered.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

// The seeded Study's one Task with a transcript — this flow appends a turn to
// a conversation that already has some, which is the ordinary case.
const ROUTE = "#/studies/s_cmp/tasks/t_3";

beforeEach(cleanup);

describe("Task clarifying question", () => {
  it("surfaces a question card mid-turn and resumes to the permission card on answer", async () => {
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);

    // A "clarify" prompt triggers the scripted question (gated in memory.ts).
    await user.type(
      await screen.findByLabelText("Message the agent"),
      "help me clarify the library choice",
    );
    // A plain send is a normal run (no plan gate), so the turn drives straight
    // into the scripted clarifying question.
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The clarifying-question card appears, with its question and options.
    expect(
      await screen.findByText(
        "Which CRISPR knockout library should the screen target?",
      ),
    ).toBeInTheDocument();

    // Answer it — one deliberate click on an option (single-select).
    await user.click(await screen.findByRole("button", { name: /Brunello/ }));

    // The turn RESUMES: the permission card follows, which only happens once the
    // answer reached the run and it continued past the question.
    expect(
      await screen.findByRole("button", {
        name: "Allow for this conversation",
      }),
    ).toBeInTheDocument();
  });
});
