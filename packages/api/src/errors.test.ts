import { expect, it } from "vitest";
import { isLykeionError, LykeionError } from "./errors";

it("carries a branchable code beside the message", () => {
  const err = new LykeionError("not-found", "no such task: t_9");
  expect(err.code).toBe("not-found");
  expect(err.message).toBe("no such task: t_9");
});

it("is a real Error, so it survives a throw and a catch", () => {
  expect(new LykeionError("invalid", "x")).toBeInstanceOf(Error);
});

it("recognises its own and nothing else", () => {
  expect(isLykeionError(new LykeionError("conflict", "x"))).toBe(true);
  expect(isLykeionError(new Error("x"))).toBe(false);
  expect(isLykeionError({ code: "not-found", message: "x" })).toBe(false);
});
