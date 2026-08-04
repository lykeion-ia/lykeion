import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateAgentModal } from "./CreateAgentModal";

afterEach(cleanup);

it("is empty-safe, disables Create until a name is typed, and creates", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  // Empty runtimes/connectors must not crash (fresh install).
  render(
    <CreateAgentModal
      runtimes={[]}
      skillNames={["rnaseq"]}
      connectorNames={[]}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );

  const create = screen.getByRole("button", { name: "Create" });
  expect(create).toBeDisabled();

  await user.type(
    screen.getByPlaceholderText(/Deep Research Agent/i),
    "Deep Research",
  );
  expect(create).toBeEnabled();
  await user.click(create);

  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate.mock.calls[0][0]).toMatchObject({
    name: "Deep Research",
    tools: [],
    connectors: [],
  });
  expect(onClose).toHaveBeenCalled();
});

it("closes on Escape", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <CreateAgentModal
      runtimes={[]}
      skillNames={[]}
      connectorNames={[]}
      onCreate={vi.fn()}
      onClose={onClose}
    />,
  );
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});

it("shows the narrowing-semantics helper copy and an empty-state nudge to Settings › Connectors", async () => {
  const user = userEvent.setup();
  render(
    <CreateAgentModal
      runtimes={[]}
      skillNames={[]}
      connectorNames={[]}
      onCreate={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  // Explicit about the ∩ (not ∪) semantics, so the misconception can't reappear here.
  expect(
    screen.getByText(
      /A specialist sees only the connectors you assign here \(intersected with what's enabled\)\. Leave empty to inherit all enabled connectors\./i,
    ),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /Add connectors/i }));
  expect(
    screen.getByText(/No connectors — add one in Settings › Connectors/i),
  ).toBeInTheDocument();
});

it("selecting a connector and creating sends connectors: [name] — a REAL Agent field (unlike the decorative skills selector)", async () => {
  const user = userEvent.setup();
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <CreateAgentModal
      runtimes={[]}
      skillNames={[]}
      connectorNames={["pubmed", "uniprot"]}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );

  await user.type(
    screen.getByPlaceholderText(/Deep Research Agent/i),
    "Deep Research",
  );
  await user.click(screen.getByRole("button", { name: /Add connectors/i }));
  await user.click(screen.getByRole("button", { name: "pubmed" }));
  await user.click(screen.getByRole("button", { name: "Create" }));

  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate.mock.calls[0][0]).toMatchObject({ connectors: ["pubmed"] });
});
