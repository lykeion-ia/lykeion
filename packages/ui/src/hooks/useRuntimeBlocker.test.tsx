/**
 * `useRuntimeBlocker` in isolation: the states it can resolve to, driven
 * directly through `ApiProvider` rather than through a screen. The marker
 * is declared the way the real server stamps the document it serves —
 * `hasWorkspaceServer()` (`../api/select.ts`) is exercised for real, not
 * replaced, so a test here cannot pass while that function disagrees about
 * what it is looking at.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createInMemoryApi, type LykeionApi, type Runtime } from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { useRuntimeBlocker } from "./useRuntimeBlocker";

function declareWorkspaceServer() {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "lykeion-workspace");
  meta.setAttribute("content", "1");
  document.head.appendChild(meta);
}

afterEach(() => {
  cleanup();
  document.querySelector('meta[name="lykeion-workspace"]')?.remove();
});

function BlockerProbe() {
  const { blocker } = useRuntimeBlocker();
  return <>{blocker ?? "composer is free"}</>;
}

/**
 * "Composer is free" is what renders both while the hook is still loading
 * AND once it has genuinely settled on `undefined` — that overlap is the
 * point of the design (a caller cannot and should not tell the two apart),
 * but it means a bare `findByText("composer is free")` can resolve on the
 * transient first render and never look again, reading green regardless of
 * what the hook actually settles on. This flushes every pending microtask
 * both `usePromise` reads could still be waiting on, so a synchronous read
 * afterward sees the settled render.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const you = {
  id: "u_you",
  email: "you@lab.example",
  displayName: "You",
  createdTs: 1,
};

const runtime = (over: Partial<Runtime>): Runtime => ({
  id: "rt_1",
  name: "bo-workstation",
  ownerId: "u_bo",
  platform: "linux-x86_64",
  daemonVersion: "0.1.0",
  health: "online",
  lastSeenTs: 1,
  capabilities: [],
  ...over,
});

describe("useRuntimeBlocker", () => {
  it("leaves the composer free in the browser-only demo, where no workspace server is declared", async () => {
    render(
      <ApiProvider api={createInMemoryApi()}>
        <BlockerProbe />
      </ApiProvider>,
    );
    await settle();
    expect(screen.getByText("composer is free")).toBeInTheDocument();
  });

  it("leaves the composer free while the reads are still in flight, against a declared workspace server", async () => {
    declareWorkspaceServer();
    const heldRuntimes = new Promise<Runtime[]>(() => {});
    const heldUser = new Promise<never>(() => {});
    const api: LykeionApi = {
      ...createInMemoryApi(),
      listRuntimes: () => heldRuntimes,
      currentUser: () => heldUser,
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    // Neither read ever settles in this test, so there is nothing for the
    // flush to move past — the point is to hold both tests in this file to
    // the same non-racing idiom rather than one that only happens to be
    // safe here because there is no later state to race toward.
    await settle();
    expect(screen.getByText("composer is free")).toBeInTheDocument();
  });

  it("leaves the composer free while the identity read is still in flight, even once the roster has landed", async () => {
    declareWorkspaceServer();
    const heldUser = new Promise<never>(() => {});
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: () => heldUser,
      // Somebody else's, so a hook that read "not yet answered" as either
      // "answered empty" or "failed" would put a notice up here.
      listRuntimes: async () => [runtime({ ownerId: "u_bo" })],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    await settle();
    expect(screen.getByText("composer is free")).toBeInTheDocument();
  });

  it("blocks the composer when the identity read FAILED, and says that rather than claiming no machine of yours is connected", async () => {
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => {
        throw new Error("the workspace server answered 503 for currentUser");
      },
      // A machine of the caller's own that CAN run sessions: every other
      // branch of this hook leaves the composer free on this roster, so a
      // notice here can only have come from the failed identity.
      listRuntimes: async () => [
        runtime({
          id: "rt_2",
          name: "your-laptop",
          ownerId: "u_you",
          capabilities: ["sessions"],
        }),
      ],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    expect(
      await screen.findByText(/could not confirm who is signed in/i),
    ).toBeInTheDocument();
    // Not this: the lab's roster is not empty, and saying it is would be a
    // false statement about the lab rather than about the reader.
    expect(screen.queryByText(/No machine of yours is connected/i)).toBeNull();
  });

  it("keeps the composer blocked when the only machine in the lab is somebody else's", async () => {
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => you,
      listRuntimes: async () => [runtime({ ownerId: "u_bo" })],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    expect(
      await screen.findByText(/No machine of yours is connected/i),
    ).toBeInTheDocument();
  });

  it("names your own machine when it has registered but cannot run sessions yet", async () => {
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => you,
      listRuntimes: async () => [
        runtime({ id: "rt_2", name: "your-laptop", ownerId: "u_you", capabilities: [] }),
      ],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    expect(
      await screen.findByText(
        /your-laptop is connected, but it cannot run sessions yet/i,
      ),
    ).toBeInTheDocument();
  });

  it("names only your own machine when the lab also holds somebody else's", async () => {
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => you,
      listRuntimes: async () => [
        runtime({ id: "rt_2", name: "your-laptop", ownerId: "u_you", capabilities: [] }),
        runtime({ id: "rt_1", name: "bo-workstation", ownerId: "u_bo", capabilities: [] }),
      ],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    expect(
      await screen.findByText(
        /your-laptop is connected, but it cannot run sessions yet/i,
      ),
    ).toBeInTheDocument();
    // Not "bo-workstation" — a colleague's machine must never be named as
    // if it belonged to the caller, whichever order the list answers in.
    expect(screen.queryByText(/bo-workstation/i)).toBeNull();
  });

  it("says none of your machines when you have more than one and none can run sessions", async () => {
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => you,
      listRuntimes: async () => [
        runtime({ id: "rt_2", name: "your-laptop", ownerId: "u_you", capabilities: [] }),
        runtime({ id: "rt_3", name: "your-workstation", ownerId: "u_you", capabilities: [] }),
      ],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    expect(
      await screen.findByText(/None of your machines can run sessions yet/i),
    ).toBeInTheDocument();
  });

  it("leaves the composer free once one of your machines can run sessions", async () => {
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => you,
      listRuntimes: async () => [
        runtime({ id: "rt_2", name: "your-laptop", ownerId: "u_you", capabilities: [] }),
        runtime({
          id: "rt_3",
          name: "your-workstation",
          ownerId: "u_you",
          capabilities: ["sessions"],
        }),
      ],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    // "composer is free" is ALSO what the first render shows, before either
    // read has settled — a bare `findByText` would resolve on that
    // transient render and never look again, so a broken hook that settled
    // on a notice afterwards would still read green here.
    await settle();
    expect(screen.getByText("composer is free")).toBeInTheDocument();
  });

  it("is not freed by a colleague's machine that can run sessions", async () => {
    // Capability is per machine and machines belong to people; somebody
    // else's ready laptop is not a machine this researcher may run on.
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => you,
      listRuntimes: async () => [runtime({ ownerId: "u_bo", capabilities: ["sessions"] })],
    };
    render(
      <ApiProvider api={api}>
        <BlockerProbe />
      </ApiProvider>,
    );
    expect(
      await screen.findByText(/No machine of yours is connected/i),
    ).toBeInTheDocument();
  });

  it("names the caller's own machines and none of the lab's others", async () => {
    declareWorkspaceServer();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      currentUser: async () => you,
      listRuntimes: async () => [
        runtime({ id: "rt_2", name: "your-laptop", ownerId: "u_you", capabilities: [] }),
        runtime({ id: "rt_1", name: "bo-workstation", ownerId: "u_bo", capabilities: [] }),
      ],
    };
    let seen: Record<string, string> = {};
    function NamesProbe() {
      seen = useRuntimeBlocker().machineNames;
      return null;
    }
    render(
      <ApiProvider api={api}>
        <NamesProbe />
      </ApiProvider>,
    );
    await settle();
    // What a colleague called their machine is theirs, and nothing the
    // composer draws needs it. Leaving it out of the map means no screen can
    // spill it by accident, whatever some other package decides to answer.
    expect(seen).toEqual({ rt_2: "your-laptop" });
  });
});
