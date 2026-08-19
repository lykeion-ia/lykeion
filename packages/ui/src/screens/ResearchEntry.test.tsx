/**
 * Opening a Research from the Researches list.
 *
 * Clicking a Research row opens the Research itself — its name, its composer and the
 * work it holds — and lands there whether or not any of that work has been
 * run. Role/text-based, agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { resetPageLoad } from "../lib/tabs-storage";

const CMP = "Cross-modal plasticity in the brain";
const ECO = "Minimum-wage effects on regional employment";

beforeEach(() => {
  cleanup();
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});

describe("Researches list → Research", () => {
  it("opens the Research of a research line that has already been worked in", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = "#/researches";
    render(<App api={api} />);

    const research = (await api.listResearches()).find((s) => s.key === "CMP")!;
    const worked = (await api.getResearch(research.id)).tasks.find(
      (t) => t.runCount > 0,
    );
    // The premise: this Research genuinely holds a Task that has been talked to,
    // so a row that resumed a chat instead of opening the Research would have
    // somewhere to go.
    expect(worked).toBeDefined();

    await user.click(
      await screen.findByRole("link", { name: new RegExp(CMP) }),
    );

    // The Research's own page — its name and its Tasks — not the transcript.
    expect(
      await screen.findByRole("heading", { name: research.title, level: 1 }),
    ).toBeInTheDocument();
    const tasks = screen.getByRole("region", { name: "All tasks" });
    expect(
      within(tasks).getByText("Preprocess two-photon calcium traces"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
  });

  it("opens the Research of a research line nobody has run yet", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = "#/researches";
    render(<App api={api} />);

    const research = (await api.listResearches()).find((s) => s.key === "ECO")!;
    expect(
      (await api.getResearch(research.id)).tasks.every((t) => t.runCount === 0),
    ).toBe(true);

    await user.click(
      await screen.findByRole("link", { name: new RegExp(ECO) }),
    );

    // The same page, with its one Task and nothing to resume.
    const tasks = await screen.findByRole("region", { name: "All tasks" });
    expect(
      within(tasks).getByText("Assemble the county-panel wage dataset"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
  });
});
