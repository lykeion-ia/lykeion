import { describe, expect, it } from "vitest";
import { createTitleRegistry } from "./title-registry";

describe("the titles a lab is waiting on a machine to write", () => {
  it("settles a wait with what the machine that was asked answered", async () => {
    const titles = createTitleRegistry();
    const waiting = titles.await("rt_1", "req_1");
    expect(titles.settle("rt_1", "req_1", "Python kernel range check")).toBe(true);
    expect(await waiting).toBe("Python kernel range check");
  });

  it("carries a machine's own 'nothing to say' through as null", async () => {
    // A daemon that tried and got nowhere answers rather than going quiet:
    // the Task keeps its name either way, but the lab stops waiting now
    // instead of at the deadline.
    const titles = createTitleRegistry();
    const waiting = titles.await("rt_1", "req_1");
    expect(titles.settle("rt_1", "req_1", null)).toBe(true);
    expect(await waiting).toBeNull();
  });

  it("gives up on its own once the wait runs out", async () => {
    const titles = createTitleRegistry();
    expect(await titles.await("rt_1", "req_1", 1)).toBeNull();
  });

  it("refuses another machine's answer, and leaves the wait open for the right one", async () => {
    const titles = createTitleRegistry();
    const waiting = titles.await("rt_1", "req_1");
    expect(titles.settle("rt_other", "req_1", "Not mine to name")).toBe(false);
    expect(titles.settle("rt_1", "req_1", "Python kernel range check")).toBe(true);
    expect(await waiting).toBe("Python kernel range check");
  });

  it("refuses a request nobody is waiting on, the same way it refuses a wrong machine", () => {
    // Answered identically on purpose: a caller probing request ids must not
    // be able to tell "not yours" from "not real".
    const titles = createTitleRegistry();
    expect(titles.settle("rt_1", "req_nope", "Invented")).toBe(false);
  });

  it("settles a request once — a second answer to it is refused", async () => {
    const titles = createTitleRegistry();
    const waiting = titles.await("rt_1", "req_1");
    expect(titles.settle("rt_1", "req_1", "First")).toBe(true);
    expect(titles.settle("rt_1", "req_1", "Second")).toBe(false);
    expect(await waiting).toBe("First");
  });
});
