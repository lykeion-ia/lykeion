import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotebookContext } from "./notebook-model";
import { NotebookAxis } from "./NotebookAxis";

const mainContext: NotebookContext = {
  name: "main",
  kernels: [],
  cells: [],
};

it("renders a one-context axis without redundant controls", () => {
  const onContextChange = vi.fn();
  const onLanguageChange = vi.fn();

  render(
    <NotebookAxis
      contexts={[mainContext]}
      activeContext="main"
      onContextChange={onContextChange}
      languages={["python"]}
      activeLanguage="python"
      onLanguageChange={onLanguageChange}
      sessionLabel="Guide design"
    />,
  );

  expect(screen.getByText("Main agent")).toBeInTheDocument();
  expect(screen.getByText("Guide design")).toBeInTheDocument();
  expect(screen.queryByRole("tablist", { name: "Kernel context" })).toBeNull();
  expect(screen.queryByRole("radiogroup", { name: "Kernel language" })).toBeNull();
});

it("changes context through tabs when multiple contexts exist", async () => {
  const user = userEvent.setup();
  const onContextChange = vi.fn();

  render(
    <NotebookAxis
      contexts={[mainContext, { ...mainContext, name: "worker" }]}
      activeContext="main"
      onContextChange={onContextChange}
      languages={["python"]}
      activeLanguage="python"
      onLanguageChange={vi.fn()}
      sessionLabel="Guide design"
    />,
  );

  await user.click(screen.getByRole("tab", { name: "worker" }));
  expect(onContextChange).toHaveBeenCalledWith("worker");
});

it("changes language through radios when multiple languages exist", async () => {
  const user = userEvent.setup();
  const onLanguageChange = vi.fn();

  render(
    <NotebookAxis
      contexts={[mainContext]}
      activeContext="main"
      onContextChange={vi.fn()}
      languages={["python", "r"]}
      activeLanguage="python"
      onLanguageChange={onLanguageChange}
      sessionLabel="Guide design"
    />,
  );

  await user.click(screen.getByRole("radio", { name: "R" }));
  expect(onLanguageChange).toHaveBeenCalledWith("r");
});
