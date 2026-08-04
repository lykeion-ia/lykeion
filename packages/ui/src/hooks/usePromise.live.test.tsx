/**
 * That a read re-runs when the lab's data changes — for every screen, not
 * only the ones whose author remembered to say so. A screen that reads
 * through `usePromise` and shows a colleague's work is the ordinary case;
 * one that keeps showing what was true when it mounted is the defect, and
 * it is invisible from inside a single browser.
 */
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import { ApiProvider, useInvalidateData } from "../api/ApiContext";
import { usePromise } from "./usePromise";

afterEach(cleanup);

function Reader({ read }: { read: () => Promise<string> }) {
  // No `useDataVersion()` here on purpose: this is a screen written the way
  // most of them are, with only its own dependencies listed.
  const q = usePromise(read, [read]);
  const invalidate = useInvalidateData();
  return (
    <>
      <p data-testid="value">{q.data ?? "…"}</p>
      <button onClick={invalidate}>something changed</button>
    </>
  );
}

it("re-reads when the lab says its data moved, without being asked to", async () => {
  const user = userEvent.setup();
  let answer = "before";
  const read = vi.fn(async () => answer);
  render(
    <ApiProvider api={createInMemoryApi()}>
      <Reader read={read} />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("before"));

  answer = "after";
  await user.click(screen.getByRole("button", { name: "something changed" }));

  await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("after"));
});

it("reads once and stays put while nothing changes", async () => {
  // The other half: a version folded into every dependency list must not
  // turn one mount into a loop of reads.
  const read = vi.fn(async () => "steady");
  render(
    <ApiProvider api={createInMemoryApi()}>
      <Reader read={read} />
    </ApiProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("steady"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(read).toHaveBeenCalledTimes(1);
});
