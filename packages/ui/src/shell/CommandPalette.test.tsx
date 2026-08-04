/**
 * The command palette against the real workbench.
 *
 * The palette finds a Task by code or title from anywhere, without first
 * choosing the Study that holds it or being assigned it. Role/text-based,
 * agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

beforeEach(cleanup);

/** Open the palette over the Studies list and hand back its input. */
async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  window.location.hash = "#/studies";
  render(<App api={createInMemoryApi()} />);
  await screen.findByText("Cross-modal plasticity in the brain");
  await user.keyboard("{Meta>}k{/Meta}");
  const palette = await screen.findByRole("dialog", { name: /command/i });
  return { palette, input: within(palette).getByRole("combobox") };
}

describe("finding a Task from the command palette", () => {
  it("surfaces a Task from part of its title and opens it", async () => {
    const user = userEvent.setup();
    const reference = createInMemoryApi();
    // CMP-7 is assigned to nobody, so the work My Tasks lists excludes it.
    const mine = new Set((await reference.myWork()).map((t) => t.id));
    expect(mine.has("t_7")).toBe(false);

    const { palette, input } = await openPalette(user);
    await user.type(input, "chemogenetic");

    // Exactly the one Task matches — a palette that offered everything would
    // satisfy a looser assertion.
    const options = within(palette).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(
      "CMP-7 · Draft a chemogenetic follow-up",
    );

    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(
      await screen.findByText(/CMP-7: Draft a chemogenetic follow-up/i),
    ).toBeInTheDocument();
  });

  it("opens a finished Task in a Study the query never names", async () => {
    const user = userEvent.setup();
    const reference = createInMemoryApi();
    const done = (await reference.getStudy("s_cmp")).tasks.find(
      (t) => t.id === "t_1",
    )!;
    expect(done.status).toBe("done");
    expect((await reference.myWork()).map((t) => t.id)).not.toContain("t_1");

    const { palette, input } = await openPalette(user);
    await user.type(input, "Survey cross-modal plasticity literature");

    // The Study "Cross-modal plasticity in the brain" is a competing match on
    // those words; the exact Task title has to win.
    await user.click(within(palette).getAllByRole("option")[0]);
    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(
      await screen.findByText(/CMP-1: Survey cross-modal plasticity/i),
    ).toBeInTheDocument();
  });

  it("still ranks a screen ahead of the Tasks for a screen's own name", async () => {
    const user = userEvent.setup();
    const { palette, input } = await openPalette(user);
    await user.type(input, "My Tasks");
    expect(within(palette).getAllByRole("option")[0]).toHaveTextContent(
      "Go to My Tasks",
    );
  });
});
