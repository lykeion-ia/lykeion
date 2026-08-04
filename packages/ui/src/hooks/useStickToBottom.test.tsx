/**
 * The stick-to-bottom hook that backs the Task transcript: pinned by
 * default, it follows new content to the bottom for as long as the researcher
 * hasn't scrolled away, and never fights a scroll that leaves the bottom.
 *
 * jsdom lays out nothing — `scrollHeight`/`clientHeight` read 0 forever — so
 * every test here drives the handler with SYNTHETIC values via
 * `Object.defineProperty`, then dispatches a real `scroll` event (or calls the
 * exposed action) rather than depending on real layout.
 */

import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useStickToBottom } from "./useStickToBottom";

afterEach(cleanup);

/** A minimal scroller + pin readout, standing in for `.conv-stream`. */
function Harness({
  dep,
  onPinnedChange,
}: {
  dep: unknown;
  onPinnedChange?: (pinned: boolean) => void;
}) {
  const { ref, pinned, jumpToLatest } = useStickToBottom<HTMLDivElement>(dep);
  useEffect(() => {
    onPinnedChange?.(pinned);
  }, [pinned, onPinnedChange]);
  return (
    <div>
      <div data-testid="scroller" ref={ref} />
      <span data-testid="pinned">{String(pinned)}</span>
      <button type="button" data-testid="jump" onClick={jumpToLatest}>
        Jump to latest
      </button>
    </div>
  );
}

/** Stamp synthetic layout onto a jsdom node — the real properties never
 *  move past 0, so the hook's math has to be fed by hand. */
function stubLayout(
  el: HTMLElement,
  {
    scrollHeight,
    clientHeight,
  }: { scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
}

describe("useStickToBottom", () => {
  it("follows new content to the bottom while pinned", () => {
    const { rerender } = render(<Harness dep={0} />);
    const el = screen.getByTestId("scroller");
    stubLayout(el, { scrollHeight: 500, clientHeight: 100 });
    el.scrollTop = 0;

    rerender(<Harness dep={1} />);

    expect(el.scrollTop).toBe(400);
    expect(screen.getByTestId("pinned")).toHaveTextContent("true");
  });

  it("unpins once a user scroll leaves more than ~40px from the bottom", () => {
    render(<Harness dep={0} />);
    const el = screen.getByTestId("scroller");
    stubLayout(el, { scrollHeight: 500, clientHeight: 100 });

    // distance = 500 - 300 - 100 = 100, well past the 40px slack.
    el.scrollTop = 300;
    fireEvent.scroll(el);

    expect(screen.getByTestId("pinned")).toHaveTextContent("false");
  });

  it("re-pins once the user scrolls back within the ~40px slack, unprompted", () => {
    render(<Harness dep={0} />);
    const el = screen.getByTestId("scroller");
    stubLayout(el, { scrollHeight: 500, clientHeight: 100 });

    el.scrollTop = 300;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned")).toHaveTextContent("false");

    // distance = 500 - 380 - 100 = 20, inside the slack — the researcher
    // scrolled back down on their own, no `jumpToLatest` call involved.
    el.scrollTop = 380;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned")).toHaveTextContent("true");
  });

  it("never fights an unpinned user: new content does not move the scroll", () => {
    const { rerender } = render(<Harness dep={0} />);
    const el = screen.getByTestId("scroller");
    stubLayout(el, { scrollHeight: 500, clientHeight: 100 });

    el.scrollTop = 300;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned")).toHaveTextContent("false");

    rerender(<Harness dep={1} />);

    expect(el.scrollTop).toBe(300);
  });

  it("jumpToLatest scrolls to the bottom and re-pins", async () => {
    const user = userEvent.setup();
    render(<Harness dep={0} />);
    const el = screen.getByTestId("scroller");
    stubLayout(el, { scrollHeight: 500, clientHeight: 100 });

    el.scrollTop = 300;
    fireEvent.scroll(el);
    expect(screen.getByTestId("pinned")).toHaveTextContent("false");

    await user.click(screen.getByTestId("jump"));

    expect(el.scrollTop).toBe(400);
    expect(screen.getByTestId("pinned")).toHaveTextContent("true");
  });
});
