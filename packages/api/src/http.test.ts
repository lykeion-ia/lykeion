import { afterEach, expect, it, vi } from "vitest";
import { createFetchTransport, createHttpApi, type Transport } from "./http";
import { isLykeionError } from "./errors";
import type { ActiveRunSnapshot, RunEvent, RunEventFrame } from "./run";

afterEach(() => {
  vi.unstubAllGlobals();
});

function transportReturning(value: unknown): Transport {
  return {
    request: vi.fn(async () => value),
    openEvents: () => () => {},
    openRun: () => () => {},
  };
}

it("sends the method name and its arguments positionally", async () => {
  const t = transportReturning({ id: "t_1" });
  const api = createHttpApi(t);
  await api.updateTask("t_1", { status: "in-review" });
  expect(t.request).toHaveBeenCalledWith("updateTask", ["t_1", { status: "in-review" }]);
});

it("sends an empty argument list for a method that takes none", async () => {
  const t = transportReturning([]);
  await createHttpApi(t).myWork();
  expect(t.request).toHaveBeenCalledWith("myWork", []);
});

it("returns whatever the transport resolves with", async () => {
  const api = createHttpApi(transportReturning([{ id: "s_1" }]));
  expect(await api.listStudies()).toEqual([{ id: "s_1" }]);
});

it("builds a RunHandle over the transport without ever carrying one", async () => {
  const frames: Array<(f: RunEventFrame) => void> = [];
  const sent: unknown[][] = [];
  const api = createHttpApi({
    request: (method, args) => {
      sent.push([method, ...args]);
      return Promise.resolve(method === "startRun" ? { runId: "run_1" } : undefined);
    },
    openEvents: () => () => {},
    openRun: (_runId, _cursor, onFrame) => {
      frames.push(onFrame);
      return () => {};
    },
  });
  const handle = await api.startRun({
    studyId: "s", taskId: "t", prompt: "go", options: { planMode: false },
  });
  expect(handle.runId).toBe("run_1");

  const seen: RunEvent[] = [];
  handle.onEvent((e) => seen.push(e));
  frames[0]!({ seq: 1, event: { event: "assistant-text", text: "hi", partial: true } });
  expect(seen).toHaveLength(1);

  handle.submit({ action: "cancel" });
  expect(sent.at(-1)).toEqual(["submitRunDecision", "run_1", { action: "cancel" }]);
});

it("close() detaches the stream and cancels an unfinished run, the same guarantee the in-process handle keeps", async () => {
  const detached = vi.fn();
  const sent: unknown[][] = [];
  const api = createHttpApi({
    request: (method, args) => {
      sent.push([method, ...args]);
      return Promise.resolve(method === "startRun" ? { runId: "run_1" } : undefined);
    },
    openEvents: () => () => {},
    openRun: () => detached,
  });
  const handle = await api.startRun({
    studyId: "s", taskId: "t", prompt: "go", options: { planMode: false },
  });
  handle.onEvent(() => {});

  handle.close();
  handle.submit({ action: "approve-plan" });

  expect(detached).toHaveBeenCalledTimes(1);
  expect(sent.filter(([method]) => method === "submitRunDecision")).toEqual([
    ["submitRunDecision", "run_1", { action: "cancel" }],
  ]);
});

it("detach() releases the stream without cancelling the unfinished run", async () => {
  const detached = vi.fn();
  const sent: unknown[][] = [];
  const api = createHttpApi({
    request: (method, args) => {
      sent.push([method, ...args]);
      return Promise.resolve(method === "startRun" ? { runId: "run_1" } : undefined);
    },
    openEvents: () => () => {},
    openRun: () => detached,
  });
  const handle = await api.startRun({
    studyId: "s", taskId: "t", prompt: "go", options: { planMode: false },
  });
  handle.onEvent(() => {});

  (handle as { detach?: () => void }).detach?.();

  expect(detached).toHaveBeenCalledTimes(1);
  expect(sent.filter(([method]) => method === "submitRunDecision")).toEqual([]);
});

it("detach() can reopen the run stream from the latest observed frame while close remains permanent", async () => {
  const opened: Array<{
    cursor: number | undefined;
    onFrame: (frame: RunEventFrame) => void;
    detach: ReturnType<typeof vi.fn>;
  }> = [];
  const sent: unknown[][] = [];
  const api = createHttpApi({
    request: (method, args) => {
      sent.push([method, ...args]);
      return Promise.resolve(method === "startRun" ? { runId: "run_reopen" } : undefined);
    },
    openEvents: () => () => {},
    openRun: (_runId, cursor, onFrame) => {
      const detach = vi.fn();
      opened.push({ cursor, onFrame, detach });
      return detach;
    },
  });
  const handle = await api.startRun({
    studyId: "s",
    taskId: "t",
    prompt: "go",
    options: { planMode: false },
  });

  const first: RunEvent[] = [];
  handle.onEvent((event) => first.push(event));
  opened[0]!.onFrame({
    seq: 4,
    event: { event: "assistant-text", text: "before detach", partial: true },
  });
  handle.detach();

  const second: RunEvent[] = [];
  handle.onEvent((event) => second.push(event));
  expect(opened.map(({ cursor }) => cursor)).toEqual([undefined, 4]);
  expect(opened[0]!.detach).toHaveBeenCalledTimes(1);
  expect(sent.filter(([method]) => method === "submitRunDecision")).toEqual([]);

  opened[1]!.onFrame({
    seq: 5,
    event: { event: "assistant-text", text: "after detach", partial: true },
  });
  expect(first).toHaveLength(1);
  expect(second).toEqual([
    { event: "assistant-text", text: "after detach", partial: true },
  ]);

  handle.close();
  expect(opened[1]!.detach).toHaveBeenCalledTimes(1);
  expect(sent.filter(([method]) => method === "submitRunDecision")).toEqual([
    ["submitRunDecision", "run_reopen", { action: "cancel" }],
  ]);
  handle.onEvent(() => {});
  expect(opened).toHaveLength(2);
});

it("closing after a terminal frame releases observation without submitting a stale cancel", async () => {
  let onFrame: ((frame: RunEventFrame) => void) | undefined;
  const sent: unknown[][] = [];
  const api = createHttpApi({
    request: (method, args) => {
      sent.push([method, ...args]);
      return Promise.resolve(method === "startRun" ? { runId: "run_done" } : undefined);
    },
    openEvents: () => () => {},
    openRun: (_runId, _cursor, receive) => {
      onFrame = receive;
      return () => {};
    },
  });
  const handle = await api.startRun({
    studyId: "s", taskId: "t", prompt: "go", options: { planMode: false },
  });
  handle.onEvent(() => {});
  onFrame?.({ seq: 1, event: { event: "completed", state: { state: "completed" } } });

  handle.close();

  expect(sent.filter(([method]) => method === "submitRunDecision")).toEqual([]);
});

it("reconstructs resumed handles from JSON and opens each stream after its snapshot cursor", async () => {
  const snapshot: ActiveRunSnapshot = {
    runId: "run_1",
    sequence: 3,
    prompt: "continue",
    agent: "claude",
    state: { state: "executing", plan: { steps: [], raw: "" } },
    stream: [{ kind: "text", text: "already durable" }],
    live: { text: "working" },
    reviewing: false,
    lastEventSeq: 7,
  };
  const opened: Array<{ runId: string; cursor: number | undefined }> = [];
  const detached = vi.fn();
  const sent: unknown[][] = [];
  const api = createHttpApi({
    request: (method, args) => {
      sent.push([method, ...args]);
      return Promise.resolve(method === "resumeRuns" ? [{ runId: "run_1", snapshot }] : undefined);
    },
    openEvents: () => () => {},
    openRun: (runId, cursor) => {
      opened.push({ runId, cursor });
      return detached;
    },
  });

  const [resumed] = await api.resumeRuns("task_1");
  expect(resumed.snapshot).toEqual(snapshot);
  resumed.onEvent(() => {});
  expect(opened).toEqual([{ runId: "run_1", cursor: 7 }]);

  resumed.submit({ action: "approve-plan" });
  expect(sent.at(-1)).toEqual(["submitRunDecision", "run_1", { action: "approve-plan" }]);
  resumed.detach();
  expect(detached).toHaveBeenCalledTimes(1);
  expect(sent.filter(([method]) => method === "submitRunDecision")).toHaveLength(1);
});

it("does not open a second stream for a second onEvent subscriber", async () => {
  let opened = 0;
  const api = createHttpApi({
    request: (method) => Promise.resolve(method === "startRun" ? { runId: "run_1" } : undefined),
    openEvents: () => () => {},
    openRun: () => {
      opened += 1;
      return () => {};
    },
  });
  const handle = await api.startRun({
    studyId: "s", taskId: "t", prompt: "go", options: { planMode: false },
  });

  handle.onEvent(() => {});
  handle.onEvent(() => {});

  expect(opened).toBe(1);
});

it("implements every method the contract declares", () => {
  // The compile-time guarantee has a machine shadow worth keeping: a method
  // left out is `undefined` here, and `undefined` is not callable.
  const api = createHttpApi(transportReturning(null));
  const missing = Object.entries(api).filter(([, v]) => typeof v !== "function");
  expect(missing).toEqual([]);
  expect(Object.keys(api)).toHaveLength(71);
});

it("propagates a contract failure as a LykeionError", async () => {
  const t: Transport = {
    request: async () => {
      throw new (await import("./errors")).LykeionError("not-found", "no such task: t_9");
    },
    openEvents: () => () => {},
    openRun: () => () => {},
  };
  const err = await createHttpApi(t)
    .getTask("t_9")
    .then(() => undefined, (e: unknown) => e);
  expect(isLykeionError(err) && err.code).toBe("not-found");
});

it("announces an unauthenticated response only once for the same lapse", async () => {
  const onUnauthenticated = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
  const transport = createFetchTransport({ onUnauthenticated });

  await expect(transport.request("currentUser", [])).rejects.toThrow();
  await expect(transport.request("currentUser", [])).rejects.toThrow();

  expect(onUnauthenticated).toHaveBeenCalledTimes(1);
});

it("stays quiet when a server error lands between two refusals", async () => {
  // A failure the server produced without ever looking at the session — a
  // gateway restarting, a route rejecting the request outright — says
  // nothing about whether anyone is signed in. Counting it as proof of a
  // live session would make one lapse announce twice, and since each
  // announcement sends the page back to re-read, twice becomes forever.
  const onUnauthenticated = vi.fn();
  const responses = [
    new Response(null, { status: 401 }),
    new Response(null, { status: 502 }),
    new Response(null, { status: 401 }),
  ];
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));
  const transport = createFetchTransport({ onUnauthenticated });

  await expect(transport.request("currentUser", [])).rejects.toThrow();
  await expect(transport.request("currentUser", [])).rejects.toThrow();
  await expect(transport.request("currentUser", [])).rejects.toThrow();

  expect(onUnauthenticated).toHaveBeenCalledTimes(1);
});

it("announces again after a later lapse, once a call in between succeeded", async () => {
  const onUnauthenticated = vi.fn();
  const responses = [
    new Response(null, { status: 401 }),
    new Response(JSON.stringify({ ok: true, value: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(null, { status: 401 }),
  ];
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));
  const transport = createFetchTransport({ onUnauthenticated });

  await expect(transport.request("currentUser", [])).rejects.toThrow();
  await transport.request("currentUser", []);
  await expect(transport.request("currentUser", [])).rejects.toThrow();

  expect(onUnauthenticated).toHaveBeenCalledTimes(2);
});

/**
 * Enough of an `EventSource` to drive the two states its `error` event can
 * be raised in. The real one is not in jsdom, and what matters here is
 * which `readyState` the listener sees, not the transport underneath.
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | undefined;

  readyState = FakeEventSource.OPEN;
  closed = false;
  private readonly listeners = new Map<string, Array<(e: { data?: string }) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, fn: (e: { data?: string }) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Raise `error` the way the browser does, in a given state. */
  fail(state: number): void {
    this.readyState = state;
    for (const fn of this.listeners.get("error") ?? []) fn({});
  }

  /** Raise a named event carrying `data`, the way a real server-sent event
   *  arrives on the wire — `change` and `frame` both go through here. */
  emit(type: string, data?: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

function stubEventSource() {
  FakeEventSource.last = undefined;
  vi.stubGlobal("EventSource", FakeEventSource);
  return () => FakeEventSource.last!;
}

it("says nobody is signed in when the event stream is closed against it", async () => {
  const onUnauthenticated = vi.fn();
  const latest = stubEventSource();
  const transport = createFetchTransport({ onUnauthenticated });
  transport.openEvents(undefined, () => {}, () => {});

  latest().fail(FakeEventSource.CLOSED);

  expect(onUnauthenticated).toHaveBeenCalledTimes(1);
});

it("sits through a dropped connection the browser is going to retry", async () => {
  // A server being restarted looks exactly like this, and the page has to
  // survive it: the whole point of the stream resuming is that an ordinary
  // interruption costs nothing. Signing somebody out over one would be a
  // worse failure than the one the CLOSED case fixes.
  const onUnauthenticated = vi.fn();
  const latest = stubEventSource();
  const transport = createFetchTransport({ onUnauthenticated });
  transport.openEvents(undefined, () => {}, () => {});

  latest().fail(FakeEventSource.CONNECTING);

  expect(onUnauthenticated).not.toHaveBeenCalled();
});

it("does not read its own teardown as the stream being taken away", async () => {
  const onUnauthenticated = vi.fn();
  const latest = stubEventSource();
  const transport = createFetchTransport({ onUnauthenticated });

  const close = transport.openEvents(undefined, () => {}, () => {});
  close();

  expect(latest().closed).toBe(true);
  expect(onUnauthenticated).not.toHaveBeenCalled();
});

it("announces a lapsed session once, whichever way it shows up first", async () => {
  const onUnauthenticated = vi.fn();
  const latest = stubEventSource();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
  const transport = createFetchTransport({ onUnauthenticated });
  transport.openEvents(undefined, () => {}, () => {});

  latest().fail(FakeEventSource.CLOSED);
  await expect(transport.request("currentUser", [])).rejects.toThrow();

  expect(onUnauthenticated).toHaveBeenCalledTimes(1);
});

it("opens a run's own stream, addressed by id, with no cursor when none is given", () => {
  const latest = stubEventSource();
  const transport = createFetchTransport({ baseUrl: "https://lab.example" });
  transport.openRun("run_1", undefined, () => {}, () => {});
  expect(latest().url).toBe("https://lab.example/runs/run_1/events");
});

it("carries a given cursor on a run stream's URL", () => {
  const latest = stubEventSource();
  const transport = createFetchTransport({ baseUrl: "https://lab.example" });
  transport.openRun("run_7", 3, () => {}, () => {});
  expect(latest().url).toBe("https://lab.example/runs/run_7/events?cursor=3");
});

it("delivers a frame the server sends on a run's stream", () => {
  const latest = stubEventSource();
  const transport = createFetchTransport();
  const seen: RunEventFrame[] = [];
  transport.openRun("run_1", undefined, (f) => seen.push(f), () => {});

  latest().emit(
    "frame",
    JSON.stringify({ seq: 1, event: { event: "assistant-text", text: "hi", partial: true } }),
  );

  expect(seen).toEqual([{ seq: 1, event: { event: "assistant-text", text: "hi", partial: true } }]);
});

it("closes the source itself on the server's own end signal, rather than leaving it to reconnect", () => {
  // An ended response with no explicit close reads to `EventSource` exactly
  // like a dropped connection, and a browser left to its own devices would
  // reconnect against a run that has nothing further to send it.
  const latest = stubEventSource();
  const transport = createFetchTransport();
  const onClose = vi.fn();
  transport.openRun("run_1", undefined, () => {}, onClose);

  latest().emit("end");

  expect(latest().closed).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("treats a refused reconnect as the run's stream ending", () => {
  const latest = stubEventSource();
  const transport = createFetchTransport();
  const onClose = vi.fn();
  transport.openRun("run_1", undefined, () => {}, onClose);

  latest().fail(FakeEventSource.CLOSED);

  expect(onClose).toHaveBeenCalledTimes(1);
});

it("sits through a dropped connection on a run's stream too — the browser is going to retry", () => {
  const latest = stubEventSource();
  const transport = createFetchTransport();
  const onClose = vi.fn();
  transport.openRun("run_1", undefined, () => {}, onClose);

  latest().fail(FakeEventSource.CONNECTING);

  expect(onClose).not.toHaveBeenCalled();
});

it("does not read its own teardown as the run's stream ending", () => {
  const latest = stubEventSource();
  const transport = createFetchTransport();
  const onClose = vi.fn();
  const close = transport.openRun("run_1", undefined, () => {}, onClose);

  close();

  expect(latest().closed).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});
