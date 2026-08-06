import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AgentOption } from "@lykeion/api";
import { ModelSwitcher } from "./ModelSwitcher";

const MODELS: AgentOption = {
  id: "model",
  category: "model",
  currentValue: "sonnet",
  choices: [
    { value: "opus", label: "Opus 5", description: "For complex tasks" },
    { value: "sonnet", label: "Sonnet 5", description: "For everyday tasks" },
    { value: "haiku", label: "Haiku 4.5" },
  ],
};

describe("ModelSwitcher", () => {
  it("lists what the agent itself advertised, and selects one", () => {
    const onSelect = vi.fn();
    render(<ModelSwitcher option={MODELS} selectedModel={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));
    fireEvent.click(screen.getByRole("option", { name: /Opus 5/ }));
    expect(onSelect).toHaveBeenCalledWith("opus");
  });

  it("shows the agent's own description where it gave one", () => {
    render(<ModelSwitcher option={MODELS} selectedModel={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));
    expect(screen.getByText("For complex tasks")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: /^Default/ })).toBeNull();
  });

  it("marks the session's own current value until the researcher picks another", () => {
    render(<ModelSwitcher option={MODELS} selectedModel={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Model: Sonnet 5" })).toBeInTheDocument();
  });

  it("reflects the selected value on the pill", () => {
    render(<ModelSwitcher option={MODELS} selectedModel="opus" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Model: Opus 5" })).toBeInTheDocument();
  });

  it("reads Default, saying why, for an agent that advertised no choice", () => {
    render(
      <ModelSwitcher
        selectedModel={null}
        reason="this agent could not be asked what it offers"
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Default").parentElement).toHaveAttribute(
      "title",
      "this agent could not be asked what it offers",
    );
  });

  it("serves reasoning effort through the same widget", () => {
    render(
      <ModelSwitcher
        option={{
          id: "thought_level",
          category: "thought_level",
          choices: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
        }}
        selectedModel="high"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
