import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModelSwitcher } from "./ModelSwitcher";

describe("ModelSwitcher", () => {
  it("lists Claude models and selects one", () => {
    const onSelect = vi.fn();
    render(
      <ModelSwitcher cliId="claude" selectedModel={null} onSelect={onSelect} />,
    );
    // Closed pill shows the default until a model is chosen.
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));
    // Each option is announced as "<model> — <when to use it>".
    fireEvent.click(screen.getByRole("option", { name: /Sonnet 5/ }));
    expect(onSelect).toHaveBeenCalledWith("sonnet");
  });

  it("shows a when-to-use description for each model, and no Default reset row", () => {
    render(
      <ModelSwitcher cliId="claude" selectedModel={null} onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));
    expect(screen.getByText("For complex tasks")).toBeInTheDocument();
    expect(
      screen.getByText("Most efficient for everyday tasks"),
    ).toBeInTheDocument();
    expect(screen.getByText("Fastest for quick answers")).toBeInTheDocument();
    // The standalone "Default" option is gone; only the three models remain.
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: /^Default/ })).toBeNull();
  });

  it("reflects the selected model on the pill", () => {
    render(
      <ModelSwitcher cliId="claude" selectedModel="opus" onSelect={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: "Model: Opus 5" }),
    ).toBeInTheDocument();
  });

  it("shows a non-interactive Default for a CLI with no catalogue", () => {
    render(
      <ModelSwitcher
        cliId="copilot"
        selectedModel={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });
});
