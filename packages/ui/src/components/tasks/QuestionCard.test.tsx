import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QuestionRequest } from "@lykeion/api";
import { QuestionCard } from "./QuestionCard";

const SINGLE: QuestionRequest = {
  requestId: "q-1",
  header: "Library",
  question: "Which CRISPR knockout library?",
  options: [
    { label: "Brunello", description: "genome-wide" },
    { label: "GeCKOv2" },
  ],
  multiSelect: false,
};

describe("QuestionCard", () => {
  it("renders the header and question", () => {
    render(<QuestionCard request={SINGLE} onAnswer={() => {}} />);
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(
      screen.getByText("Which CRISPR knockout library?"),
    ).toBeInTheDocument();
  });

  it("single-select answers with the clicked option's label", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard request={SINGLE} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Brunello"));
    expect(onAnswer).toHaveBeenCalledWith(["Brunello"]);
  });

  it("'Let the agent decide' answers with an empty selection (a skip)", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard request={SINGLE} onAnswer={onAnswer} />);
    await userEvent.click(screen.getByText("Let the agent decide"));
    expect(onAnswer).toHaveBeenCalledWith([]);
  });

  it("multi-select accumulates checks behind a Submit that carries the set", async () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        request={{ ...SINGLE, multiSelect: true }}
        onAnswer={onAnswer}
      />,
    );
    const submit = screen.getByRole("button", { name: "Submit" });
    // Nothing chosen yet — Submit can't commit an empty multi-select set.
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByText("Brunello"));
    await userEvent.click(screen.getByText("GeCKOv2"));
    await userEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith(["Brunello", "GeCKOv2"]);
  });
});
