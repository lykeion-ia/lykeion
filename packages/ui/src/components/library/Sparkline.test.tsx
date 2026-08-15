import { afterEach, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Sparkline } from "./Sparkline";

afterEach(cleanup);

it("draws against the ceiling it was given, not against its own peak", () => {
  // The whole point: a kernel holding 600 KB on an 8 GB machine must not
  // look like one holding 6 GB just because 600 KB is its own maximum.
  const { container } = render(
    <Sparkline values={[100, 200, 300]} ceiling={1_000_000} />,
  );
  expect(container.textContent).toBe("▁▁▁");
});

// Every "renders nothing" case below is asserted on there being no element at
// all, never on the text being empty. `join` turns an out-of-range block
// lookup into the empty string, so a component that renders a `<span>` full
// of `NaN` marks reads exactly like one that returned `null` if all a test
// looks at is `textContent` — which is how the two cases underneath this
// component's own guard came to be uncovered in the first place.
it("renders nothing at all for a series nobody could measure", () => {
  const { container } = render(<Sparkline values={[]} ceiling={100} />);
  expect(container.firstChild).toBeNull();
});

it("renders nothing for a series whose every reading is a measurement nobody took", () => {
  // Not the same case as the empty list above: this series has slots, and
  // every one of them is absent. Only the empty list was covered, so the
  // filter that turns this into the empty case could have been dropped
  // without the suite noticing.
  const { container } = render(
    <Sparkline values={[undefined, undefined]} ceiling={1_000_000} />,
  );
  expect(container.firstChild).toBeNull();
});

it("draws the readings a probe did get, and skips the ticks it could not", () => {
  // A probe that lost one tick to a process it could not read has still
  // measured the others, and those are worth drawing — two marks here, not
  // three. Filling the gap with a zero would draw a machine dropping to
  // nothing and climbing back, which is the "absent is not zero" rule broken
  // as a picture.
  const { container } = render(
    <Sparkline values={[100, undefined, 1_000_000]} ceiling={1_000_000} />,
  );
  expect(container.textContent).toBe("▁█");
});

it("renders nothing when there is no capacity to judge the readings against", () => {
  // A ceiling of nothing is what an unreported machine size arrives as, and a
  // ceiling of zero is what the division would then be done by. Neither was
  // covered: undefined draws `NaN` marks that `join` hides, and zero divides
  // into `Infinity` and paints every block full.
  expect(render(<Sparkline values={[1, 2, 3]} ceiling={undefined} />).container.firstChild).toBeNull();
  cleanup();
  expect(render(<Sparkline values={[1, 2, 3]} ceiling={0} />).container.firstChild).toBeNull();
});
