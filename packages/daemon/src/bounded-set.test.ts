import { expect, it } from "vitest";
import { addBounded } from "./bounded-set";

it("does not evict anything while a bounded set is still under its limit", () => {
  const set = new Set<string>();
  addBounded(set, "a", 2);
  addBounded(set, "b", 2);
  expect(set).toEqual(new Set(["a", "b"]));
});

it("evicts a bounded set's oldest member once it would grow past its limit", () => {
  const set = new Set<string>();
  addBounded(set, "a", 2);
  addBounded(set, "b", 2);
  addBounded(set, "c", 2);
  expect(set).toEqual(new Set(["b", "c"]));
});
