import { expect, it } from "vitest";
import { healthFor } from "./runtime-health";

it("is online within three heartbeats", () => {
  expect(healthFor(1_000, 1_000)).toBe("online");
  expect(healthFor(1_000, 1_045)).toBe("online");
});

it("is unstable once beats are being missed", () => {
  expect(healthFor(1_000, 1_046)).toBe("unstable");
  expect(healthFor(1_000, 1_300)).toBe("unstable");
});

it("is offline after five minutes of silence", () => {
  expect(healthFor(1_000, 1_301)).toBe("offline");
});
