import { afterEach, expect, it, vi } from "vitest";
import { createFetchTransport, createHttpApi, type Transport } from "./http";
import { isLykeionError } from "./errors";

afterEach(() => {
  vi.unstubAllGlobals();
});

function transportReturning(value: unknown): Transport {
  return {
    request: vi.fn(async () => value),
    openEvents: () => () => {},
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

it("implements every method the contract declares", () => {
  // The compile-time guarantee has a runtime shadow worth keeping: a method
  // left out is `undefined` here, and `undefined` is not callable.
  const api = createHttpApi(transportReturning(null));
  const missing = Object.entries(api).filter(([, v]) => typeof v !== "function");
  expect(missing).toEqual([]);
  expect(Object.keys(api)).toHaveLength(63);
});

it("propagates a contract failure as a LykeionError", async () => {
  const t: Transport = {
    request: async () => {
      throw new (await import("./errors")).LykeionError("not-found", "no such task: t_9");
    },
    openEvents: () => () => {},
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
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, fn: () => void): void {
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
    for (const fn of this.listeners.get("error") ?? []) fn();
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
