/**
 * The customization engine, end-to-end in the UI.
 *
 * Drives the engine panels against the in-memory API:
 *  - Skills (Settings › Capabilities): a seeded skill row appears and its
 *    enable toggle calls through.
 *  - Connectors (Settings › Connectors): Add a catalog entry and it appears
 *    under Your connectors.
 * Role/text-based, so it's agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { resetTabs } from "../lib/tabs";

beforeEach(() => {
  cleanup();
  // The strip is a module store now, so a test that renders `<App>` without
  // setting its own hash would otherwise inherit whichever route the last
  // test's navigation left the active tab on.
  resetTabs();
  window.location.hash = "";
});

describe("Skills panel", () => {
  it("lists a seeded skill and toggles it enabled through the API", async () => {
    const user = userEvent.setup();
    render(<App api={createInMemoryApi()} />);

    await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
    await user.click(await screen.findByRole("button", { name: "Skills" }));

    // A seeded skill row appears with its description.
    expect(await screen.findByText("rnaseq")).toBeInTheDocument();
    expect(screen.getByText(/differential-expression/i)).toBeInTheDocument();

    // rnaseq is seeded enabled; its switch is checked and disabling flips it.
    const toggle = screen.getByRole("switch", { name: "Disable rnaseq" });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(
      await screen.findByRole("switch", { name: "Enable rnaseq" }),
    ).not.toBeChecked();
  });
});

describe("Connectors panel", () => {
  it("adds a catalog connector to Your connectors", async () => {
    const user = userEvent.setup();
    render(<App api={createInMemoryApi()} />);
    await screen.findByText("Cross-modal plasticity in the brain");

    // Reached the way a screen is reached: from the rail, then its tab. The
    // palette used to be the way in, and no longer indexes screens at all — it
    // holds Studies and Tasks, which is what it is opened for.
    await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
    await user.click(await screen.findByRole("button", { name: "Connectors" }));

    const yourConnectors = await screen.findByTestId("your-connectors");
    // UniProt is in the catalog but not yet attached.
    expect(
      within(yourConnectors).queryByText("UniProt"),
    ).not.toBeInTheDocument();

    // Add it from the catalog.
    await user.click(screen.getByRole("button", { name: "Add UniProt" }));

    // It now appears under Your connectors.
    expect(
      await within(yourConnectors).findByText("UniProt"),
    ).toBeInTheDocument();
  });
});
