/**
 * The breadcrumb's tab band.
 *
 * What is NOT here: that the band lands on `.conv-column`. That is one CSS
 * grid track against one centred column, both sized from a single
 * `--conv-measure` declared on `.task-main` — and jsdom performs no layout, so
 * a test asserting it would be asserting its own arithmetic. The single
 * declaration is the guard; hoisting it out of `.conversation` is what this
 * band cost, and it is why there is now nothing left to drift.
 *
 * What IS here is the behaviour clipping introduced: an edge with more beyond
 * it reads as soft rather than as the end of the list, and a tab activated
 * from outside the clip is brought back inside it.
 *
 * And one thing about the landing that is not arithmetic and so can be
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
 * it are equal, and a track sized from its own content is a track whose width
 * the page's data decides. So the question worth asking of the stylesheet is
 * not how wide anything ends up — jsdom computes none of it — but which of the
 * three tracks is allowed to be sized by something unbounded.
 */
describe("the strip the band rides in", () => {
  const css = readFileSync(
    join(import.meta.dirname, "..", "..", "screens", "task.css"),
    "utf8",
  );

  /** The three `minmax()`es of `.crumb-strip--banded`, in track order. */
  const tracks = () => {
    const rule = css.match(/\.crumb-strip--banded\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const decl = rule.match(/grid-template-columns:([^;]+);/)?.[1] ?? "";
    return decl.match(/minmax\((?:[^()]|\([^()]*\))*\)/g) ?? [];
  };

  it("gives the band a track of its own, the conversation's measure wide", () => {
    const [, band] = tracks();

    expect(tracks()).toHaveLength(3);
    expect(band).toContain("var(--conv-measure)");
  });

  it("floors the trail's track on a stated width, never on the Study's name", () => {
    const [trail] = tracks();

    // A Study's title is the user's to write and can be any length. Sized from
    // its content, the trail's track claims whatever the title needs and the
    // band is pushed off the column it names — the Study's name running into
    // the Task's. Under a stated floor the name truncates instead.
    expect(trail).not.toContain("min-content");
  });

  it("still lets the actions keep their width", () => {
    const [, , actions] = tracks();

    // The other side is safe on its content: what rides there is a CLI's brand
    // name and a pane toggle — the app's own words, not the user's — so
    // `min-content` there is a bound, not an opening.
    expect(actions).toContain("min-content");
  });
});
