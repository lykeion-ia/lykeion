/**
 * The artifact viewers.
 *
 * Renders each viewer with its fixture blob and asserts it renders, plus one
 * dispatcher test that `ArtifactViewer` picks the right viewer per content
 * type. Role/text/testid-based, so it's agnostic to the exact markup.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactViewer } from "./ArtifactViewer";
import { TableChartViewer } from "./TableChartViewer";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
import { NotebookViewer } from "./NotebookViewer";
import {
  binaryBlob,
  csvBlob,
  ipynbBlob,
  jsonBlob,
  pdfBlob,
  pngBlob,
} from "./__fixtures__/blobs";

beforeEach(cleanup);

describe("TableChartViewer", () => {
  it("renders the header cells and a data row, and charts on toggle", async () => {
    const user = userEvent.setup();
    const { container } = render(<TableChartViewer blob={csvBlob} />);

    // Header cells + a data row (the table is the default view).
    expect(screen.getByText("neuron")).toBeInTheDocument();
    expect(screen.getByText("orientation_deg")).toBeInTheDocument();
    expect(screen.getByText("n01")).toBeInTheDocument();
    expect(screen.getByText("0.81")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();

    // Toggling to Chart renders a self-contained inline SVG.
    await user.click(screen.getByRole("button", { name: "Chart" }));
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("ImageViewer", () => {
  it("shows an <img> whose src is a data:image/png URL", () => {
    render(<ImageViewer blob={pngBlob} />);
    const img = screen.getByRole("img", { name: "results/fig.png" });
    expect(img.getAttribute("src")?.startsWith("data:image/png")).toBe(true);
  });
});

describe("PdfViewer", () => {
  it("embeds an application/pdf element with a data:application/pdf src", () => {
    const { container } = render(<PdfViewer blob={pdfBlob} />);
    const embed = container.querySelector("embed");
    expect(embed).not.toBeNull();
    expect(embed?.getAttribute("type")).toBe("application/pdf");
    expect(embed?.getAttribute("src")?.startsWith("data:application/pdf")).toBe(
      true,
    );
  });
});

describe("NotebookViewer", () => {
  it("renders the markdown, the code cell, and its output", () => {
    render(<NotebookViewer blob={ipynbBlob} />);
    // Markdown cell text.
    expect(screen.getByText(/Orientation tuning/)).toBeInTheDocument();
    // Code cell source + In[ ] gutter.
    expect(screen.getByText(/import pandas as pd/)).toBeInTheDocument();
    expect(screen.getByText(/In \[1\]:/)).toBeInTheDocument();
    // Outputs: the stream line and the text/plain result.
    expect(screen.getByText(/loaded 7 neurons/)).toBeInTheDocument();
    expect(screen.getByText(/mean tuning index: 0\.72/)).toBeInTheDocument();
  });
});

describe("ArtifactViewer dispatcher", () => {
  it("routes CSV to the table/chart viewer", () => {
    render(<ArtifactViewer blob={csvBlob} />);
    expect(screen.getByRole("button", { name: "Table" })).toBeInTheDocument();
    expect(screen.getByText("orientation_deg")).toBeInTheDocument();
  });

  it("routes PNG to the image viewer", () => {
    render(<ArtifactViewer blob={pngBlob} />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")?.startsWith("data:image/png")).toBe(true);
  });

  it("routes PDF to the embed viewer", () => {
    const { container } = render(<ArtifactViewer blob={pdfBlob} />);
    expect(
      container.querySelector('embed[type="application/pdf"]'),
    ).not.toBeNull();
  });

  it("routes the notebook to the notebook viewer", () => {
    render(<ArtifactViewer blob={ipynbBlob} />);
    expect(screen.getByText(/Orientation tuning/)).toBeInTheDocument();
  });

  it("routes JSON/text to the mono code fallback", () => {
    const { container } = render(<ArtifactViewer blob={jsonBlob} />);
    const pre = container.querySelector("pre.code-text");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("neurons");
  });

  it("shows a placeholder for unpreviewable binary", () => {
    render(<ArtifactViewer blob={binaryBlob} />);
    expect(screen.getByText("Preview not available")).toBeInTheDocument();
    // The detail names the path, type, and byte count.
    expect(screen.getByText(/model\.bin/)).toBeInTheDocument();
    expect(screen.getByText(/application\/octet-stream/)).toBeInTheDocument();
    expect(screen.getByText(/byte/)).toBeInTheDocument();
  });
});
