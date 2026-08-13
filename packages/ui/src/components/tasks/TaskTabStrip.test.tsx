/**
 * The breadcrumb's tab band.
 *
 * What is NOT here: how far from the crumb trail the band comes to rest. That
 * is three CSS grid tracks measured against a row of unknown width — and jsdom
 * performs no layout, so a test asserting it would be asserting its own
 * arithmetic.
 *
 * What IS here is the behaviour clipping introduced: an edge with more beyond
 * it reads as soft rather than as the end of the list, and a tab activated
 * from outside the clip is brought back inside it.
 *
 * And one thing about the placement that is not arithmetic and so can be
 * asserted without performing any: WHAT is allowed to size the strip's tracks.
 * See the last block in this file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskTabStrip } from "./TaskTabStrip";

const TABS = [
  { id: "t1", label: "Fit tuning curves", closable: true },
  { id: "t2", label: "Sweep the priors", closable: true },
  { id: "t3", label: "Plot the residuals", closable: true },
];

beforeEach(cleanup);

/**
 * State the geometry jsdom will not compute: how wide the clip is, how wide
 * the tabs are together, and a `scrollLeft` that actually holds what is
 * written to it.
 */
function stateGeometry(
  band: HTMLElement,
  { clip, content }: { clip: number; content: number },
) {
  Object.defineProperty(band, "clientWidth", {
    value: clip,
    configurable: true,
  });
  Object.defineProperty(band, "scrollWidth", {
    value: content,
    configurable: true,
  });
  let scrollLeft = 0;
  Object.defineProperty(band, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (next: number) => {
      scrollLeft = next;
    },
  });
}

/** Lay the tabs out end to end, each `width` wide. */
function layOutTabs(band: HTMLElement, width: number) {
  Array.from(band.children).forEach((child, i) => {
    Object.defineProperty(child, "offsetLeft", {
      value: i * width,
      configurable: true,
    });
    Object.defineProperty(child, "offsetWidth", {
      value: width,
      configurable: true,
    });
  });
}

function renderStrip(activeId = "t1", handlers: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <TaskTabStrip
      tabs={TABS}
      activeId={activeId}
      onSelect={onSelect}
      onClose={onClose}
      {...handlers}
    />,
  );
  return { ...view, onSelect, onClose };
}

describe("the faded edges", () => {
  it("softens only the end while the band sits at its start", () => {
    renderStrip();
    const band = screen.getByTestId("task-tab-band");
    stateGeometry(band, { clip: 300, content: 900 });

    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("end");
  });

  it("softens both edges once there are tabs either side of the clip", () => {
    renderStrip();
    const band = screen.getByTestId("task-tab-band");
    stateGeometry(band, { clip: 300, content: 900 });

    band.scrollLeft = 300;
    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("both");
  });

  it("softens only the start once the last tab is reached", () => {
    renderStrip();
    const band = screen.getByTestId("task-tab-band");
    stateGeometry(band, { clip: 300, content: 900 });

    band.scrollLeft = 600;
    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("start");
  });

  it("leaves both edges hard when every tab fits", () => {
    renderStrip();
    const band = screen.getByTestId("task-tab-band");
    stateGeometry(band, { clip: 900, content: 900 });

    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("none");
  });
});

describe("following the active tab", () => {
  it("brings a tab past the right edge just inside it", () => {
    const { rerender, onSelect, onClose } = renderStrip("t1");
    const band = screen.getByTestId("task-tab-band");
    stateGeometry(band, { clip: 300, content: 900 });
    layOutTabs(band, 300);

    rerender(
      <TaskTabStrip
        tabs={TABS}
        activeId="t3"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    // t3 ends at 900; the clip is 300 wide, so it lands flush at the right.
    expect(band.scrollLeft).toBe(600);
  });

  it("moves by the shortest distance rather than centring the tab", () => {
    const { rerender, onSelect, onClose } = renderStrip("t1");
    const band = screen.getByTestId("task-tab-band");
    stateGeometry(band, { clip: 300, content: 900 });
    layOutTabs(band, 300);

    rerender(
      <TaskTabStrip
        tabs={TABS}
        activeId="t2"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    expect(band.scrollLeft).toBe(300);
  });

  it("brings a tab past the left edge back to it", () => {
    const { rerender, onSelect, onClose } = renderStrip("t3");
    const band = screen.getByTestId("task-tab-band");
    stateGeometry(band, { clip: 300, content: 900 });
    layOutTabs(band, 300);
    band.scrollLeft = 600;

    rerender(
      <TaskTabStrip
        tabs={TABS}
        activeId="t1"
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    expect(band.scrollLeft).toBe(0);
  });
});

describe("the tabs themselves", () => {
  it("names the active tab as pressed and the rest as not", () => {
    renderStrip("t2");

    expect(
      screen.getByRole("button", { name: "Sweep the priors" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Fit tuning curves" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("opens a tab that is clicked", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderStrip("t1");

    await user.click(screen.getByRole("button", { name: "Plot the residuals" }));

    expect(onSelect).toHaveBeenCalledWith("t3");
  });

  it("closes a tab from its own close button", async () => {
    const user = userEvent.setup();
    const { onClose, onSelect } = renderStrip("t1");

    await user.click(
      screen.getByRole("button", { name: "Close Sweep the priors" }),
    );

    expect(onClose).toHaveBeenCalledWith("t2");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers no close button on a lone tab", () => {
    render(
      <TaskTabStrip
        tabs={[{ id: "t1", label: "Fit tuning curves" }]}
        activeId="t1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /^Close / }),
    ).not.toBeInTheDocument();
  });
});

/**
 * The band sits on the conversation's column only while the two tracks beside
 * it are equal, and it can only fall back to sitting beside the trail if the
 * trail's track is floored on the trail's own width. Both readings are of the
 * same three track sizings, and a track sized from its own content is a track
 * whose width the page's data decides. So the question worth asking of the
 * stylesheet is not how wide anything ends up — jsdom computes none of it — but
 * what each of the three tracks is allowed to be sized by, and where the thing
 * that bounds the one open to the user's own words has been put.
 */
describe("the strip the band rides in", () => {
  const css = readFileSync(
    join(import.meta.dirname, "..", "..", "screens", "task.css"),
    "utf8",
  );

  const ruleFor = (selector: string) =>
    css.match(
      new RegExp(`${selector.replace(/[.>*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\}`),
    )?.[1] ?? "";

  const strip = ruleFor(".crumb-strip--banded");
  const trailBox = ruleFor(".crumb-strip--banded > nav");

  /** The three `minmax()`es of `.crumb-strip--banded`, in track order. */
  const tracks = () => {
    const decl = strip.match(/grid-template-columns:([^;]+);/)?.[1] ?? "";
    return decl.match(/minmax\((?:[^()]|\([^()]*\))*\)/g) ?? [];
  };

  it("gives the band a track of its own, the conversation's measure wide", () => {
    const [, band] = tracks();

    expect(tracks()).toHaveLength(3);
    expect(band).toContain("var(--conv-measure)");
  });

  it("floors the trail's track on the trail's own width", () => {
    const [trail] = tracks();

    // This is what closes the gap once the row is too narrow to hold the
    // measure — the inspector open, or the window pulled in. There the band
    // takes every spare pixel and still falls short of the column, so whatever
    // the trail's track is floored on is dead space between `Studies › {Study}`
    // and the first tab. Floored on the name itself there is none: the tabs
    // follow straight on. A stated floor left a gap the width of the floor.
    expect(trail).toBe("minmax(min-content, 1fr)");
  });

  it("bounds that floor on the nav, never on the Study's name", () => {
    // `min-content` above is an opening: a Study's title is the user's to write
    // and can be any length, and a floor sized on it is a floor the data sets —
    // past the trail's equal share it stops being slack and becomes a demand,
    // prising the `1fr` tracks apart and shifting the band off the column.
    //
    // A box's min-content contribution is clamped by its own max-width, so the
    // cap has to be on the nav: capping the element is what caps the track.
    expect(trailBox).toContain("max-width: var(--crumb-trail-cap)");
    expect(strip).toMatch(/--crumb-trail-cap:\s*\d+ch;/);
  });

  it("still lets the actions keep their width", () => {
    const [, , actions] = tracks();

    // The other side is safe on its content: what rides there is a CLI's brand
    // name and a pane toggle — the app's own words, not the user's — so
    // `min-content` there is a bound, not an opening.
    expect(actions).toContain("min-content");
  });
});
