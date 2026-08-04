import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  LykeionApi,
  RunEvent,
  RunHandle,
  StartRunInput,
} from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { planOf, useRun } from "./useRun";

afterEach(cleanup);

/**
 * A run that emits `executing` and then goes silent — the "Running… (stuck)"
 * case (a hung CLI or a dropped event). It never completes on its own.
 */
function stalledApi(): { api: LykeionApi; submitted: string[] } {
  const submitted: string[] = [];
  const plan = { steps: [{ title: "work", done: false }], raw: "1. work" };
  const handle: RunHandle = {
    runId: "run-stalled",
    onEvent(cb: (e: RunEvent) => void) {
      setTimeout(
        () => cb({ event: "state", state: { state: "executing", plan } }),
        0,
      );
      return () => {};
    },
    submit(d) {
      submitted.push(d.action);
    },
    close() {},
  };
  const api = {
    startRun: (_input: StartRunInput) => Promise.resolve(handle),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;
  return { api, submitted };
}

function Harness({ api }: { api: LykeionApi }) {
  return (
    <ApiProvider api={api}>
      <Probe />
    </ApiProvider>
  );
}

function Probe() {
  const run = useRun("s1", { taskId: "t1" });
  return (
    <div>
      <span data-testid="state">{run.state?.state ?? "none"}</span>
      <span data-testid="running">{String(run.running)}</span>
      <span data-testid="reviewing">{String(run.reviewing)}</span>
      <span data-testid="plan-status">
        {(run.plan?.steps ?? []).map((s) => s.status ?? "none").join(",")}
      </span>
      {/* One element per recorded assistant message — the real surface paints
          exactly one bubble per entry, so counting these counts bubbles. */}
      {run.messages.map((m, i) => (
        <span key={i} data-testid="bubble">
          {m}
        </span>
      ))}
      {run.live.text != null && (
        <span data-testid="live-text">{run.live.text}</span>
      )}
      <button type="button" onClick={() => run.start("do it")}>
        start
      </button>
      <button type="button" onClick={run.cancel}>
        stop
      </button>
    </div>
  );
}

/**
 * A run whose events are pushed manually, one at a time, so a test can inspect
 * the surface MID-TURN — between a fragment and the whole message that ends it.
 */
function drivenApi(): { api: LykeionApi; emit: (e: RunEvent) => void } {
  let cb: ((e: RunEvent) => void) | null = null;
  const handle: RunHandle = {
    runId: "run-driven",
    onEvent(fn: (e: RunEvent) => void) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    submit() {},
    close() {},
  };
  const api = {
    startRun: (_input: StartRunInput) => Promise.resolve(handle),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;
  return { api, emit: (e: RunEvent) => cb?.(e) };
}

it("Stop releases a stalled run so the surface is never bricked", async () => {
  const user = userEvent.setup();
  const { api, submitted } = stalledApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  // The run reaches `executing` and then goes silent.
  await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(screen.getByTestId("state")).toHaveTextContent("executing");
  expect(screen.getByTestId("running")).toHaveTextContent("true");

  // Without Stop the surface would stay `running` forever (composer disabled,
  // every send swallowed). Stop must always end the turn locally.
  await user.click(screen.getByRole("button", { name: "stop" }));
  expect(screen.getByTestId("state")).toHaveTextContent("failed");
  expect(screen.getByTestId("running")).toHaveTextContent("false");
  // The core still gets told, so it can clean the turn up its own way.
  expect(submitted).toContain("cancel");
});

it("warns instead of silently hanging when an event tag drifts", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const handle: RunHandle = {
    runId: "run-drift",
    onEvent(cb: (e: RunEvent) => void) {
      setTimeout(
        () => cb({ event: "totally-unknown" } as unknown as RunEvent),
        0,
      );
      return () => {};
    },
    submit() {},
    close() {},
  };
  const api = {
    startRun: () => Promise.resolve(handle),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;

  const user = userEvent.setup();
  render(<Harness api={api} />);
  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 10)));

  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("unhandled run event"),
    expect.anything(),
  );
  warn.mockRestore();
});

it("streams partial prose via the live tail, then paints ONE bubble", async () => {
  // The regression: with the real CLI (which emits deltas) the runner forwards
  // BOTH partial fragments and the reassembled whole message as `assistant-text`.
  // If the surface appended every one, two fragments + the whole message would
  // paint THREE bubbles and each fragment would ALSO show in the live tail.
  // The fix: append only whole messages (`partial: false`); fragments are shown
  // solely by the `live` snapshot's `text` tail.
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  // Let the `startRun` promise resolve so the event listener is attached.
  await act(() => new Promise((r) => setTimeout(r, 0)));

  // The turn types itself out: two fragments, each accompanied by a `live`
  // snapshot carrying the accumulating text.
  await act(async () => {
    emit({ event: "assistant-text", text: "Strong ", partial: true });
    emit({ event: "live", live: { text: "Strong " } });
    emit({ event: "assistant-text", text: "candidates", partial: true });
    emit({ event: "live", live: { text: "Strong candidates" } });
  });

  // MID-TURN — before the whole message arrives (and before completion, whose
  // cleanup would mask the bug). The streaming text is visible via the live
  // tail, and NOT a single bubble has been painted from a fragment.
  expect(screen.getByTestId("live-text")).toHaveTextContent(
    "Strong candidates",
  );
  expect(screen.queryAllByTestId("bubble")).toHaveLength(0);

  // The runner reassembles the run of fragments and re-emits the whole message.
  await act(async () => {
    emit({
      event: "assistant-text",
      text: "Strong candidates",
      partial: false,
    });
  });

  // Exactly ONE bubble for the message — not three.
  const bubbles = screen.getAllByTestId("bubble");
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0]).toHaveTextContent("Strong candidates");
});

it("tracks live plan-step status and the Reviewing phase", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);
  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));

  // A live executing snapshot with per-step status → the strip's current step.
  const plan = {
    steps: [
      { title: "a", done: true, status: "completed" as const },
      { title: "b", done: false, status: "in_progress" as const },
      { title: "c", done: false, status: "pending" as const },
    ],
    raw: "",
  };
  await act(async () => {
    emit({ event: "state", state: { state: "executing", plan } });
  });
  expect(screen.getByTestId("plan-status")).toHaveTextContent(
    "completed,in_progress,pending",
  );
  expect(screen.getByTestId("reviewing")).toHaveTextContent("false");

  // The Reviewer phase flips on, then clears when the run lands.
  await act(async () => {
    emit({ event: "reviewing" });
  });
  expect(screen.getByTestId("reviewing")).toHaveTextContent("true");

  await act(async () => {
    emit({ event: "completed", state: { state: "completed" } });
  });
  expect(screen.getByTestId("reviewing")).toHaveTextContent("false");
});

describe("planOf", () => {
  it("keeps the sticky plan when a permission card has no plan", () => {
    // A gate raised during planning serialises without `plan`.
    expect(
      planOf({
        state: "awaiting-permission",
        request: {
          id: "perm-1",
          access: { kind: "read-path", target: "." },
          tool: "Read",
        },
      }),
    ).toBeNull();
  });
});
