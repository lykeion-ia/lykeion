import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { createInMemoryApi, type ChangeEvent, type Transport } from "@lykeion/api";
import { ApiProvider, useDataVersion } from "../api/ApiContext";
import { useChangeChannel } from "./useChangeChannel";

afterEach(cleanup);

/** A transport whose event stream this test drives by hand. */
function controllableTransport() {
  let push: ((e: ChangeEvent) => void) | undefined;
  let resync: (() => void) | undefined;
  const close = vi.fn();
  const transport: Transport = {
    request: async () => null,
    openEvents(_cursor, onEvent, onResync) {
      push = onEvent;
      resync = onResync;
      return close;
    },
    openRun: () => () => {},
  };
  return {
    transport,
    close,
    change: (seq: number) => push!({ seq, kind: "task-updated", payload: {} }),
    resync: () => resync!(),
  };
}

/** Renders the data version, which is the only thing the hook touches. */
function VersionProbe({ transport }: { transport: Transport }) {
  useChangeChannel(transport);
  return <p data-testid="version">{useDataVersion()}</p>;
}

function renderProbe(transport: Transport) {
  return render(
    <ApiProvider api={createInMemoryApi()}>
      <VersionProbe transport={transport} />
    </ApiProvider>,
  );
}

it("moves the data version when a change arrives, so every screen re-reads", async () => {
  // The hook updates nothing itself. Its whole job is to say that what the
  // screens are showing may be stale, through the one signal they already
  // watch.
  const driver = controllableTransport();
  renderProbe(driver.transport);
  const before = screen.getByTestId("version").textContent;

  driver.change(1);

  await waitFor(() =>
    expect(screen.getByTestId("version").textContent).not.toBe(before),
  );
});

it("moves it again on a second change, rather than only the first", async () => {
  const driver = controllableTransport();
  renderProbe(driver.transport);
  driver.change(1);
  await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("1"));
  driver.change(2);
  await waitFor(() => expect(screen.getByTestId("version").textContent).toBe("2"));
});

it("moves it on a resync too, because then everything may be stale", async () => {
  const driver = controllableTransport();
  renderProbe(driver.transport);
  const before = screen.getByTestId("version").textContent;

  driver.resync();

  await waitFor(() =>
    expect(screen.getByTestId("version").textContent).not.toBe(before),
  );
});

it("closes the stream when it goes away, so a remount does not leave two", () => {
  const driver = controllableTransport();
  const { unmount } = renderProbe(driver.transport);
  unmount();
  expect(driver.close).toHaveBeenCalled();
});

it("does nothing at all without a transport, which is demo mode", () => {
  // There is nothing to spy on: the point is that the hook reaches for no
  // stream at all, so the observable is that it renders and leaves the data
  // version where it started rather than announcing anything.
  render(
    <ApiProvider api={createInMemoryApi()}>
      <VersionProbe transport={undefined as unknown as Transport} />
    </ApiProvider>,
  );
  expect(screen.getByTestId("version").textContent).toBe("0");
});
