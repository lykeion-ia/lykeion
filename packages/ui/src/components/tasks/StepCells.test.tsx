import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepCells } from "./StepCells.js";

describe("StepCells", () => {
  it("renders nothing for a step that produced no cells", () => {
    // Every non-kernel step is this case, and a heading over an empty list
    // on all of them would be a section that means nothing where it appears.
    const { container } = render(<StepCells cells={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the cells the step produced, in order", () => {
    render(
      <StepCells
        cells={[
          { id: "cell_1", source: "x = 1", language: "python", ok: true } as never,
          { id: "cell_2", source: "y = 2", language: "python", ok: true } as never,
        ]}
      />,
    );
    const sources = screen.getAllByTestId("step-cell-source").map((n) => n.textContent);
    expect(sources).toEqual(["x = 1", "y = 2"]);
  });

  it("marks a cell that raised", () => {
    render(<StepCells cells={[{ id: "c", source: "boom", language: "python", ok: false } as never]} />);
    expect(screen.getByTestId("step-cell").className).toContain("--err");
  });
});
