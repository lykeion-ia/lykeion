import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type LykeionApi,
  type Machine,
  type RunningKernel,
  type User,
} from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import App from "../App";
import { MachinesScreen } from "./MachinesScreen";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("Machines renders the always-present onboarding card", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /Machines/i }));
  // listMachines() returns nothing yet, so the tables are hidden and the
  // steps are the whole page. `findByRole` throws on a second match, which
  // is the assertion: one heading, and no control beside it offering
  // something it cannot do.
  expect(
    await screen.findByRole("heading", { name: "Add your first machine" }),
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
  await screen.findByRole("heading", { name: /Add your first machine/i });

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
    await screen.findByRole("heading", { name: "Add your first machine" }),
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
    screen.getByRole("heading", { name: "Add your first machine" }),
  ).toBeInTheDocument();
});

function machine(overrides: Partial<Machine> = {}): Machine {
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
  // refuses every machine call outright): the row leaving the screen has to
  // be the result of `removeMachine` reaching this list and `listMachines`
  // coming back without it, not a client-side trick that only looks that way.
  let machines: Machine[] = [machine()];
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listMachines: async () => machines,
    removeMachine: async (machineId: string) => {
      machines = machines.filter((r) => r.id !== machineId);
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
  const listMachines = vi.fn().mockResolvedValue([]);
  const api: LykeionApi = { ...createInMemoryApi(), listMachines };

  render(
    <ApiProvider api={api}>
      <MachinesScreen />
    </ApiProvider>,
  );

  // The first read, on mount — nothing to do with the timer yet.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(listMachines).toHaveBeenCalledTimes(1);

  // Health is derived from the last heartbeat on every read; nothing pushes
  // a fresh one, so only this fifteen-second re-read can ever move a row
  // from Online to Offline while somebody is already looking at it.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(listMachines).toHaveBeenCalledTimes(2);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(listMachines).toHaveBeenCalledTimes(3);
});

it("clears its interval on unmount, rather than leaking one that fires forever", async () => {
  vi.useFakeTimers();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listMachines: vi.fn().mockResolvedValue([]),
  };

  const { unmount } = render(
    <ApiProvider api={api}>
      <MachinesScreen />
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

function runningKernel(overrides: Partial<RunningKernel> = {}): RunningKernel {
  return {
    id: "k_1",
    machineId: "rt_1",
    studyId: "st_1",
    sessionId: "ses_1",
    taskId: "tk_1",
    name: "main",
    language: "python",
    state: "running",
    incarnation: 1,
    executionCount: 1,
    queueDepth: 0,
    environment: "python",
    startedTs: 1_700_000_000,
    lastActivityTs: 1_700_000_000,
    ...overrides,
  };
}

it("confirming Stop with nothing typed, or only whitespace, sends no feedback either way — the record carries no stopReason key", async () => {
  // `stopReason` is absent when nothing was said — never `""` — and the
  // composer seeds its input at `""` and sends it unconditionally on
  // confirm. This pins the fix at the seam that turns an untyped, or
  // typed-but-blank, reason back into an absent one before it ever reaches
  // the wire: `MachinesScreen`'s `onStop`. Two kernels, one Python and one
  // R, so the two Stop composers this test opens in turn have distinct
  // accessible names rather than colliding on the same one.
  const user = userEvent.setup();
  let kernels: RunningKernel[] = [
    runningKernel({ id: "k_1", language: "python" }),
    runningKernel({ id: "k_2", language: "r" }),
  ];
  const kernelStop = vi.fn(async (kernelId: string, feedback?: string) => {
    kernels = kernels.map((k) => {
      if (k.id !== kernelId) return k;
      const next: RunningKernel = { ...k, state: "stopped" };
      // Mirrors the host's own `_described`: the key is reported only when a
      // reason was actually given, exactly the "absent is not zero" rule
      // `RunningKernel.stopReason`'s own doc comment states.
      if (feedback !== undefined) next.stopReason = feedback;
      return next;
    });
  });
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listMachines: async () => [machine()],
    listRunningKernels: async () => kernels,
    kernelStop,
  };

  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /Machines/i }));
  await screen.findByText("ana-macbook");

  // Nothing typed.
  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  await user.click(screen.getByRole("menuitem", { name: /^Stop$/ }));
  await user.click(screen.getByRole("button", { name: /^Stop$/ }));

  await waitFor(() => expect(kernelStop).toHaveBeenCalledTimes(1));
  expect(kernelStop).toHaveBeenNthCalledWith(1, "k_1", undefined);

  // Only whitespace typed — a reason with something in it by a length check,
  // but nothing said by this project's rule.
  await user.click(screen.getByRole("button", { name: /Actions for the R kernel/i }));
  await user.click(screen.getByRole("menuitem", { name: /^Stop$/ }));
  await user.type(
    screen.getByRole("textbox", { name: /Why the R kernel is being stopped/i }),
    "   ",
  );
  await user.click(screen.getByRole("button", { name: /^Stop$/ }));

  await waitFor(() => expect(kernelStop).toHaveBeenCalledTimes(2));
  expect(kernelStop).toHaveBeenNthCalledWith(2, "k_2", undefined);

  const after = await api.listRunningKernels();
  expect(after[0]!.state).toBe("stopped");
  expect(after[1]!.state).toBe("stopped");
  // Key presence, not value, on both: `undefined` and `""` would both pass a
  // naive `toBeUndefined()` or falsy check, and this project's rule is that
  // an unstated value is omitted, not present-and-empty.
  expect(Object.prototype.hasOwnProperty.call(after[0]!, "stopReason")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(after[1]!, "stopReason")).toBe(false);
});

it("carries a sentence a researcher typed through to the kernel being stopped", async () => {
  // The half the two cases above never covered: both send nothing, so
  // `feedback.trim() || undefined` collapsing every reason to `undefined`
  // passed the whole UI suite — and the sentence is the entire reason this
  // control takes a text box rather than being a menu item on its own.
  const user = userEvent.setup();
  let kernels: RunningKernel[] = [runningKernel({ id: "k_1", language: "python" })];
  const kernelStop = vi.fn(async (kernelId: string, feedback?: string) => {
    kernels = kernels.map((k) => {
      if (k.id !== kernelId) return k;
      const next: RunningKernel = { ...k, state: "stopped" };
      if (feedback !== undefined) next.stopReason = feedback;
      return next;
    });
  });
  const api: LykeionApi = {
    ...createInMemoryApi(),
    listMachines: async () => [machine()],
    listRunningKernels: async () => kernels,
    kernelStop,
  };

  render(<App api={api} />);
  await user.click(await screen.findByRole("link", { name: /Machines/i }));
  await screen.findByText("ana-macbook");

  await user.click(screen.getByRole("button", { name: /Actions for the Py kernel/i }));
  await user.click(screen.getByRole("menuitem", { name: /^Stop$/ }));
  await user.type(
    screen.getByRole("textbox", { name: /Why the Py kernel is being stopped/i }),
    "  redo this using less memory  ",
  );
  await user.click(screen.getByRole("button", { name: /^Stop$/ }));

  await waitFor(() => expect(kernelStop).toHaveBeenCalledTimes(1));
  // Trimmed, and still said: the surrounding whitespace is not part of what
  // the researcher wrote, and stripping it must not strip the sentence with
  // it — which is the failure the two blank cases above cannot see.
  expect(kernelStop).toHaveBeenNthCalledWith(1, "k_1", "redo this using less memory");

  const after = await api.listRunningKernels();
  expect(after[0]!.stopReason).toBe("redo this using less memory");
});
