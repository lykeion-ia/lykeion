import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type LykeionApi, type Runtime, type User } from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import App from "../App";
import { RuntimesScreen } from "./RuntimesScreen";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("Runtimes renders the always-present onboarding card", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /Machines/i }));
  // listRuntimes() returns nothing yet, so the tables are hidden and the
  // steps are the whole page. `findByRole` throws on a second match, which
  // is the assertion: one heading, and no control beside it offering
  // something it cannot do.
  expect(
    await screen.findByRole("heading", { name: "Add your first computer" }),
  ).toBeInTheDocument();
});

it("keeps this screen about machines, and does not inventory their environments", async () => {
  // Environments used to sit under the roster. They are a property of a
  // kernel rather than of the lab's machines, and a section that reported
  // "Not set up" against a fresh install described a state nobody had asked
  // about — on the screen whose subject is what to do next.
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /Machines/i }));
  await screen.findByRole("heading", { name: /Add your first computer/i });

  expect(screen.queryByText("Environments")).toBeNull();
  expect(screen.queryByText("Python · uv")).toBeNull();
});

it("keeps the onboarding card up while identity is unknown, and after it fails to resolve", async () => {
  const user = userEvent.setup();
  let reject: (err: Error) => void = () => {};
  const held = new Promise<User>((_resolve, r) => {
    reject = r;
  });
  const api: LykeionApi = {
    ...createInMemoryApi(),
    currentUser: () => held,
  };
  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /Machines/i }));

  // currentUser() has not answered yet — the card needs no identity at all,
  // so it must not wait on one either. An unknown identity owns no machine,
  // which is the same state as having none, and it resolves to the steps
  // rather than to the collapsed line: hiding them from somebody who may
  // have no machine takes away the one thing this screen is for.
  expect(
    await screen.findByRole("heading", { name: "Add your first computer" }),
  ).toBeInTheDocument();

  // The identity question then fails outright. The error is now visible,
  // and — this is the regression under test — the card is still there
  // rather than having vanished along with the grouped lists it never
  // depended on.
  reject(new Error("session expired"));
  await waitFor(() =>
    expect(screen.getByText(/session expired/i)).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("heading", { name: "Add your first computer" }),
  ).toBeInTheDocument();
});

function machine(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: "rt_1",
    name: "ana-macbook",
    ownerId: "u_you",
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    health: "online",
    lastSeenTs: 1_700_000_000,
    capabilities: [],
    ...overrides,
  };
}

it("removes a machine from the screen once its removal is confirmed", async () => {
  const user = userEvent.setup();
  // A fake lab that actually holds state, rather than the browser core (which
  // refuses every runtime call outright): the row leaving the screen has to
  // be the result of `removeRuntime` reaching this list and `listRuntimes`
  // coming back without it, not a client-side trick that only looks that way.
  let runtimes: Runtime[] = [machine()];
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listRuntimes: async () => runtimes,
    removeRuntime: async (runtimeId: string) => {
      runtimes = runtimes.filter((r) => r.id !== runtimeId);
    },
  };
  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /Machines/i }));
  await screen.findByText("ana-macbook");

  await user.click(screen.getByRole("button", { name: /Remove ana-macbook/i }));
  const dialog = await screen.findByRole("dialog", { name: /remove machine/i });
  await user.click(within(dialog).getByRole("button", { name: /^remove$/i }));

  await waitFor(() => expect(screen.queryByText("ana-macbook")).toBeNull());
});

it("re-reads the roster every fifteen seconds while the screen stays mounted", async () => {
  vi.useFakeTimers();
  const listRuntimes = vi.fn().mockResolvedValue([]);
  const api: LykeionApi = { ...createInMemoryApi(), listRuntimes };

  render(
    <ApiProvider api={api}>
      <RuntimesScreen />
    </ApiProvider>,
  );

  // The first read, on mount — nothing to do with the timer yet.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(listRuntimes).toHaveBeenCalledTimes(1);

  // Health is derived from the last heartbeat on every read; nothing pushes
  // a fresh one, so only this fifteen-second re-read can ever move a row
  // from Online to Offline while somebody is already looking at it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(listRuntimes).toHaveBeenCalledTimes(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(listRuntimes).toHaveBeenCalledTimes(3);
});

it("clears its interval on unmount, rather than leaking one that fires forever", async () => {
  vi.useFakeTimers();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listRuntimes: vi.fn().mockResolvedValue([]),
  };

  const { unmount } = render(
    <ApiProvider api={api}>
      <RuntimesScreen />
    </ApiProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  // Two timers outstanding — the roster's refresh and the kernel tree's,
  // which runs faster because a kernel changes state inside one turn while a
  // machine's health changes on a heartbeat. Asserted on the timer queue
  // itself, not on a later fetch count: React drops a state update targeting
  // an already-unmounted component either way, so a fetch count would keep
  // passing whether or not the intervals were ever cleared.
  expect(vi.getTimerCount()).toBe(2);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
