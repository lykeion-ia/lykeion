import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { RailRow, TurnRail, type RailMarker } from "./TurnRail";

/**
 * The rail primitive: the marker vocabulary, the nesting, and the one thing
 * that is NOT decoration — the status word a non-`ok` tool row carries for a
 * reader who cannot see its marker.
 */

const MARKERS: RailMarker[] = [
  "prose",
  "thinking",
  "ok",
  "running",
  "blocked",
  "error",
];

describe("RailRow — the marker vocabulary", () => {
  it("puts every marker on the row, as data and as a class", () => {
    // The row carries its own marker, so a stylesheet and a test can both ask
    // what kind of event this is without reading its text.
    for (const marker of MARKERS) {
      const { unmount } = render(
        <RailRow marker={marker} testid="row">
          <p>content</p>
        </RailRow>,
      );
      const row = screen.getByTestId("row");
      expect(row).toHaveAttribute("data-marker", marker);
      expect(row).toHaveClass(`rail-row--${marker}`);
      expect(row.querySelector(".rail-marker")).toHaveClass(
        `rail-marker--${marker}`,
      );
      unmount();
    }
  });

  it("draws a refusal and a failure as GLYPHS, not as differently-tinted dots", () => {
    // Colour alone never carries a bad outcome. It is also what lets the step
    // row's label drop its tense (see `stepArgument`): take the glyphs away and
    // "Write results/out.csv" would have to say again that nothing was written.
    render(
      <>
        <RailRow marker="blocked">
          <p>refused</p>
        </RailRow>
        <RailRow marker="error">
          <p>failed</p>
        </RailRow>
      </>,
    );
    expect(screen.getByText("⊘")).toHaveClass("rail-marker--blocked");
    expect(screen.getByText("✕")).toHaveClass("rail-marker--error");
  });

  it("hides the marker from assistive tech — it is a shape, and the row has words", () => {
    render(
      <RailRow marker="ok" testid="row">
        <p>content</p>
      </RailRow>,
    );
    expect(
      screen.getByTestId("row").querySelector(".rail-marker"),
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("says in words what a running, blocked or failed row means", () => {
    for (const [marker, word] of [
      ["running", "running"],
      ["blocked", "blocked"],
      ["error", "failed"],
    ] as const) {
      const { unmount } = render(
        <RailRow marker={marker} testid="row">
          <p>content</p>
        </RailRow>,
      );
      const row = screen.getByTestId("row");
      expect(within(row).getByText(word)).toHaveClass("sr-only");
      // Inside the CONTENT cell, not inside the aria-hidden marker — nesting it
      // there would hide the one thing that must not be hidden.
      expect(row.querySelector(".rail-body")).toContainElement(
        within(row).getByText(word),
      );
      unmount();
    }
  });

  it("says nothing extra for the markers that make no claim about a step", () => {
    // `ok` is the unremarkable case, and announcing it before each of fifteen
    // steps is noise. `prose` and `thinking` are not tool steps at all — there
    // is no status to state.
    for (const marker of ["prose", "thinking", "ok"] as const) {
      const { unmount } = render(
        <RailRow marker={marker} testid="row">
          <p>content</p>
        </RailRow>,
      );
      expect(screen.getByTestId("row").querySelector(".sr-only")).toBeNull();
      unmount();
    }
  });

  it("takes extra classes on the row itself, not on a wrapper around it", () => {
    // The step card's status modifiers ride on the row, so the row IS the card
    // and nothing sits between it and the rail's grid.
    render(
      <RailRow marker="ok" testid="row" className="tool-step tool-step--ok">
        <p>content</p>
      </RailRow>,
    );
    const row = screen.getByTestId("row");
    expect(row).toHaveClass("rail-row", "tool-step", "tool-step--ok");
  });

  it("omits the testid entirely when none is asked for", () => {
    const { container } = render(
      <RailRow marker="prose">
        <p>content</p>
      </RailRow>,
    );
    expect(container.querySelector(".rail-row")).not.toHaveAttribute(
      "data-testid",
    );
  });
});

describe("TurnRail — the container", () => {
  it("renders its rows as its own direct children, with no gap element between", () => {
    // The rail line is drawn per ROW and must join up: anything the container
    // inserted between two rows would show as a break in it.
    const { container } = render(
      <TurnRail>
        <RailRow marker="prose">
          <p>one</p>
        </RailRow>
        <RailRow marker="ok">
          <p>two</p>
        </RailRow>
      </TurnRail>,
    );
    const rail = container.querySelector(".turn-rail")!;
    expect([...rail.children].map((c) => c.className)).toEqual([
      "rail-row rail-row--prose",
      "rail-row rail-row--ok",
    ]);
  });

  it("marks a nested rail so an open group's steps read as hanging off it", () => {
    render(
      <TurnRail>
        <RailRow marker="ok">
          <TurnRail nested>
            <RailRow marker="ok">
              <p>child</p>
            </RailRow>
          </TurnRail>
        </RailRow>
      </TurnRail>,
    );
    const nested = screen.getByTestId("turn-rail-nested");
    expect(nested).toHaveClass("turn-rail--nested");
    // Two distinct hooks, so a test can tell an outer rail from an inner one.
    expect(screen.getByTestId("turn-rail")).not.toBe(nested);
    expect(screen.getByTestId("turn-rail")).toContainElement(nested);
  });
});
