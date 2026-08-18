/**
 * The inspector's tab strip — now the only strip `useTabBand` drives, so the
 * hook's behaviour is stated here rather than deferred. The breadcrumb used to
 * carry a band of open-Task tabs and `TaskTabStrip.test.tsx` was where the
 * clipping was pinned; the tabs came off the breadcrumb and the coverage moved
 * here with the last caller.
 *
 * Two things, then. The load this strip carries — which tabs it draws, which of
 * them can be closed, and that closing one is not also selecting it. And the
 * behaviour clipping introduces: an edge with more beyond it reads as soft
 * rather than as the end of the list, and a tab activated from outside the clip
 * is brought back inside it.
 *
 * What is NOT here is where the band comes to rest on the row. That is layout,
 * and jsdom performs none — a test asserting it would be asserting its own
 * arithmetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RightPaneTabs,
  tabAfterClose,
  type RightPaneTab,
} from "./RightPaneTabs";

beforeEach(cleanup);

/** Every notebook tab is called `Notebook`. Position and tooltip are what tell
 *  them apart, so the fixture is deliberately two identically-labelled tabs —
 *  and both close, because the strip lists notebooks that were opened and the
 *  reader's own Task has no privileged one among them. `Files` closes too: it
 *  is a surface opened into the pane like any other, not the pane itself. */
const TABS: RightPaneTab[] = [
  { id: "files", label: "Files", closable: true },
  {
    id: "notebook:t_1",
    label: "Notebook",
    title: "Notebook — Preprocess the traces",
    closable: true,
    closeLabel: "Close notebook Preprocess the traces",
  },
  {
    id: "notebook:t_2",
    label: "Notebook",
    title: "Notebook — Sweep the priors",
    closable: true,
    closeLabel: "Close notebook Sweep the priors",
  },
];

/** One of the two notebooks, addressed the way the surface distinguishes it. */
const carried = () => screen.getByTitle("Notebook — Sweep the priors");

function renderStrip(activeId = "files") {
  const onSelect = vi.fn();
  const onCloseTab = vi.fn();
  const onToggleFocus = vi.fn();
  const onClosePane = vi.fn();
  const view = render(
    <RightPaneTabs
      tabs={TABS}
      activeId={activeId}
      onSelect={onSelect}
      onCloseTab={onCloseTab}
      paneMode="split"
      onToggleFocus={onToggleFocus}
      onClosePane={onClosePane}
    />,
  );
  return { ...view, onSelect, onCloseTab, onToggleFocus, onClosePane };
}

it("marks the tab the pane is showing", () => {
  renderStrip("notebook:t_2");

  expect(carried()).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  // Two tabs read "Notebook"; only the one being shown is marked.
  const notebooks = screen.getAllByRole("tab", { name: "Notebook" });
  expect(notebooks).toHaveLength(2);
  expect(
    notebooks.filter((t) => t.getAttribute("aria-selected") === "true"),
  ).toHaveLength(1);
});

it("reports the tab that was chosen by id", async () => {
  const user = userEvent.setup();
  const { onSelect } = renderStrip();

  await user.click(carried());
  expect(onSelect).toHaveBeenCalledWith("notebook:t_2");
});

it("closes a notebook without also selecting it", async () => {
  const user = userEvent.setup();
  const { onCloseTab, onSelect } = renderStrip();

  // Every tab the caller marks closable draws one, `Files` included — the
  // strip keeps no exceptions of its own.
  expect(
    screen.getByRole("button", { name: "Close Files" }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^Close notebook/ })).toHaveLength(
    2,
  );

  // Named after its Task, since the label no longer distinguishes it, and said
  // as "notebook" so it cannot be confused with the conversation strip's close
  // for that same Task.
  await user.click(
    screen.getByRole("button", { name: "Close notebook Sweep the priors" }),
  );
  expect(onCloseTab).toHaveBeenCalledWith("notebook:t_2");
  // Closing a tab is not a way of selecting it.
  expect(onSelect).not.toHaveBeenCalled();
});

it("keeps the pane's own controls out of the tablist", async () => {
  const user = userEvent.setup();
  const { onToggleFocus, onClosePane } = renderStrip();

  // Inside the list they would scroll away with the tabs, and the band's
  // measure of what still fits would be counting them as tabs.
  const list = screen.getByRole("tablist", { name: "Right pane" });
  expect(within(list).queryByLabelText("Close panel")).toBeNull();
  expect(within(list).queryByLabelText("Expand panel")).toBeNull();
  expect(screen.getAllByRole("tab")).toHaveLength(3);

  await user.click(screen.getByRole("button", { name: "Expand panel" }));
  expect(onToggleFocus).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Close panel" }));
  expect(onClosePane).toHaveBeenCalled();
});

/**
 * Where the pane goes when the tab it is showing is taken off the strip.
 *
 * Its neighbour, and never a home tab: there is no longer one to fall back to,
 * so the answer is positional or it is nothing at all.
 */
it("hands the pane to the next tab when the one it shows is closed", () => {
  expect(tabAfterClose(TABS, "files")).toBe("notebook:t_1");
});

it("hands the pane back one when the tab it shows is the last", () => {
  expect(tabAfterClose(TABS, "notebook:t_2")).toBe("notebook:t_1");
});

it("has nowhere to hand the pane when the only tab closes", () => {
  // Which is the cue to put the inspector away: a pane is its tabs, and one
  // with an empty strip is naming nothing.
  expect(tabAfterClose([{ id: "files", label: "Files", closable: true }], "files")).toBeNull();
});

it("names which Task each notebook belongs to, in its tooltip", () => {
  renderStrip();

  // The label cannot say it — every notebook tab reads "Notebook" — so the
  // tooltip is where a strip of them stays legible. Every one carries it: the
  // reader's own Task is not distinguishable by position either, since the
  // strip is in the order the notebooks were opened.
  expect(carried()).toHaveAttribute("title", "Notebook — Sweep the priors");
  expect(carried()).toHaveTextContent("Notebook");
  expect(screen.getAllByRole("tab", { name: "Notebook" })[0]).toHaveAttribute(
    "title",
    "Notebook — Preprocess the traces",
  );
});

/**
 * State the geometry jsdom will not compute: how wide the clip is, how wide the
 * tabs are together, and a `scrollLeft` that actually holds what is written to
 * it.
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

/** The band itself, plus a way to move the active tab under it. The handlers
 *  are beside the point here — what is under test is the hook. */
function renderBand(activeId = "files") {
  const noop = vi.fn();
  const props = (id: string) => ({
    tabs: TABS,
    activeId: id,
    onSelect: noop,
    onCloseTab: noop,
    paneMode: "split" as const,
    onToggleFocus: noop,
    onClosePane: noop,
  });
  const view = render(<RightPaneTabs {...props(activeId)} />);
  return {
    band: screen.getByTestId("rightpane-tab-band"),
    show: (id: string) => view.rerender(<RightPaneTabs {...props(id)} />),
  };
}

describe("the faded edges", () => {
  it("softens only the end while the band sits at its start", () => {
    const { band } = renderBand();
    stateGeometry(band, { clip: 300, content: 900 });

    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("end");
  });

  it("softens both edges once there are tabs either side of the clip", () => {
    const { band } = renderBand();
    stateGeometry(band, { clip: 300, content: 900 });

    band.scrollLeft = 300;
    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("both");
  });

  it("softens only the start once the last tab is reached", () => {
    const { band } = renderBand();
    stateGeometry(band, { clip: 300, content: 900 });

    band.scrollLeft = 600;
    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("start");
  });

  it("leaves both edges hard when every tab fits", () => {
    const { band } = renderBand();
    stateGeometry(band, { clip: 900, content: 900 });

    fireEvent.scroll(band);

    expect(band.dataset.overflow).toBe("none");
  });
});

describe("following the active tab", () => {
  it("brings a tab past the right edge just inside it", () => {
    const { band, show } = renderBand("files");
    stateGeometry(band, { clip: 300, content: 900 });
    layOutTabs(band, 300);

    show("notebook:t_2");

    // The third tab ends at 900; the clip is 300 wide, so it lands flush at
    // the right rather than being centred.
    expect(band.scrollLeft).toBe(600);
  });

  it("moves by the shortest distance rather than centring the tab", () => {
    const { band, show } = renderBand("files");
    stateGeometry(band, { clip: 300, content: 900 });
    layOutTabs(band, 300);

    show("notebook:t_1");

    expect(band.scrollLeft).toBe(300);
  });

  it("brings a tab past the left edge back to it", () => {
    const { band, show } = renderBand("notebook:t_2");
    stateGeometry(band, { clip: 300, content: 900 });
    layOutTabs(band, 300);
    band.scrollLeft = 600;

    show("files");

    expect(band.scrollLeft).toBe(0);
  });
});
