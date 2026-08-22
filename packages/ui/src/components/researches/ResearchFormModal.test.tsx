import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Research } from "@lykeion/api";
import { ResearchFormModal } from "./ResearchFormModal";

afterEach(cleanup);

const existing: Research = {
  id: "s_cmp",
  key: "CMP",
  title: "Cross-modal plasticity in the brain",
  environmentDefaults: [],
  description: "Whether visual cortex reallocated to touch.",
  agentContext: "Traces are ΔF/F.",
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 2,
};

it("opens empty and creates when it is given no Research", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<ResearchFormModal onClose={vi.fn()} onSubmit={onSubmit} />);

  expect(
    screen.getByRole("heading", { name: "New Research" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue("");

  await user.type(screen.getByLabelText("Name"), "Auditory remapping");
  await user.click(screen.getByRole("button", { name: "Create" }));

  expect(onSubmit).toHaveBeenCalledWith({
    title: "Auditory remapping",
    description: "",
    agentContext: "",
  });
});

it("opens on a Research's current values and saves an edit to all three fields", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ResearchFormModal research={existing} onClose={vi.fn()} onSubmit={onSubmit} />,
  );

  // The form is the Research as it stands — an edit box that opens blank would
  // silently invite you to retype what is already there.
  expect(
    screen.getByRole("heading", { name: "Edit Research" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Name")).toHaveValue(existing.title);
  expect(screen.getByLabelText("Description")).toHaveValue(
    existing.description,
  );
  expect(screen.getByLabelText("Agent Context")).toHaveValue(
    existing.agentContext,
  );

  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Renamed research");
  await user.clear(screen.getByLabelText("Agent Context"));
  await user.type(screen.getByLabelText("Agent Context"), "Report counts.");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(onSubmit).toHaveBeenCalledWith({
    title: "Renamed research",
    description: existing.description,
    agentContext: "Report counts.",
  });
});

it("clears a description by emptying it, rather than leaving it unpatched", async () => {
  // An empty string is a real value on `ResearchPatch` — it is how a Research says
  // it has no description. Omitting the field would leave the old text.
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ResearchFormModal research={existing} onClose={vi.fn()} onSubmit={onSubmit} />,
  );

  await user.clear(screen.getByLabelText("Description"));
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ description: "" }),
  );
});

it("refuses to submit a Research whose name has been emptied", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <ResearchFormModal research={existing} onClose={vi.fn()} onSubmit={onSubmit} />,
  );

  await user.clear(screen.getByLabelText("Name"));
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(onSubmit).not.toHaveBeenCalled();
});
