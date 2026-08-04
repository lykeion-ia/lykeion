import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createInMemoryApi } from "@lykeion/api";
import { ApiProvider } from "./ApiContext";
import { useDirectory } from "../hooks/useDirectory";

function Broken() {
  useDirectory();
  return null;
}

afterEach(cleanup);

function Consumer({ userId }: { userId: string }) {
  const dir = useDirectory();
  return (
    <span>{dir.loaded ? (dir.user(userId)?.displayName ?? "gone") : "loading"}</span>
  );
}

it("fetches the member list once and shares it across every useDirectory() consumer", async () => {
  const api = createInMemoryApi();
  const spy = vi.spyOn(api, "listMembers");

  render(
    <ApiProvider api={api}>
      <Consumer userId="u_you" />
      <Consumer userId="u_amara" />
      <Consumer userId="u_you" />
    </ApiProvider>,
  );

  expect(await screen.findAllByText("You")).toHaveLength(2);
  expect(screen.getByText("Amara")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledTimes(1);
});

it("reports pending, not a wrong answer, before the member list arrives", async () => {
  const api = createInMemoryApi();
  render(
    <ApiProvider api={api}>
      <Consumer userId="u_you" />
    </ApiProvider>,
  );
  expect(screen.getByText("loading")).toBeInTheDocument();
  // Let the pending fetch settle so it doesn't leak into the next test.
  await screen.findByText("You");
});

it("settles into the fallback, not a permanently blank chip, when listMembers rejects", async () => {
  const api = createInMemoryApi();
  vi.spyOn(api, "listMembers").mockRejectedValue(new Error("network down"));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  render(
    <ApiProvider api={api}>
      <Consumer userId="u_you" />
    </ApiProvider>,
  );

  // Settles to the "loaded but this id is unknown" fallback rather than
  // staying on "loading" forever, and the rejection was reported, not
  // swallowed.
  expect(await screen.findByText("gone")).toBeInTheDocument();
  expect(errorSpy).toHaveBeenCalled();

  errorSpy.mockRestore();
});

it("throws immediately when useDirectory() is used outside <ApiProvider>", () => {
  // React logs the thrown error to the console too; keep the test's own
  // output clean.
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => render(<Broken />)).toThrow(
    "useDirectory() must be used inside <ApiProvider>",
  );
  errorSpy.mockRestore();
});
