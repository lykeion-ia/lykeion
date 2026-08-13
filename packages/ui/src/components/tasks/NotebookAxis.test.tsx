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
  expect(screen.queryByRole("radiogroup", { name: "Cell language" })).toBeNull();
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

it("offers All as the way back, and marks it when nothing is chosen", async () => {
  // A lens the researcher cannot take off is a lens that has hidden part of
  // the record for good, so `All` is a chip of its own rather than a second
  // click on the language — and it is what the group marks while no language
  // is chosen, which is how the panel opens.
  const user = userEvent.setup();
  const onLanguageChange = vi.fn();

  const { rerender } = render(
    <NotebookAxis
      contexts={[mainContext]}
      activeContext="main"
      onContextChange={vi.fn()}
      languages={["python", "r"]}
      activeLanguage={null}
      onLanguageChange={onLanguageChange}
      sessionLabel="Guide design"
    />,
  );

  expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "Python" })).not.toBeChecked();

  rerender(
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

  expect(screen.getByRole("radio", { name: "All" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Python" })).toBeChecked();

  await user.click(screen.getByRole("radio", { name: "All" }));
  expect(onLanguageChange).toHaveBeenCalledWith(null);
});
