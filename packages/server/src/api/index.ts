import type { LykeionApi } from "@lykeion/api";
import type { Store } from "../store/store";
import type { Actor } from "../auth";
import type { ServerConfig } from "../config";
import type { Channel } from "../channel";
import type { RunRelay } from "../run-relay";
import type { RevertRegistry } from "../run-revert";
import type { KernelListRegistry } from "../kernel-list-registry";
import type { TitleRegistry } from "../title-registry";
import type { PendingCells } from "../kernel-cells";
import type { ChangeRecorder } from "./changes";
import { absentApi } from "./absent";
import { accountApi } from "./account";
import { configSurfaceApi } from "./config-surface";
import { settingsApi } from "./settings";
import { studiesApi } from "./studies";
import { tasksApi } from "./tasks";
import { taskNamingApi } from "./task-naming";
import { machinesApi } from "./machines";
import { sessionsApi } from "./sessions";
import { kernelsApi } from "./kernels";

/** What every family module is handed. `now` is a function so tests can
 *  pin the clock and prove the ordering tiebreak does the work. */
export interface Deps {
  store: Store;
  actor: Actor;
  now(): number;
  config: ServerConfig;
  /** The workspace's change feed. Families reach it through `changes`
   *  rather than directly, so what they record and what the request fans
   *  out afterwards cannot come apart. */
  channel: Channel;
  /** The run command queue and event fan-out, held for the process's whole
   *  lifetime the same way `channel` is. */
  runs: RunRelay;
  /** Reverts waiting on the machine that holds the files to say whether
   *  they are back. Held for the process's lifetime, like `runs`. */
  reverts: RevertRegistry;
  /** `kernel-list` asks waiting on a machine's own kernel host to say what
   *  it is holding. Held for the process's lifetime, like `runs`. */
  kernelLists: KernelListRegistry;
  /** `name-task` asks waiting on a machine to summarize a Task's opening
   *  message. Held for the process's lifetime, like `runs`. */
  titles: TitleRegistry;
  /** The REPL cells this lab has asked a machine to run and is still waiting
   *  to be told the outcome of. Held for the process's lifetime, like
   *  `runs`. */
  pendingCells: PendingCells;
  /**
   * Where a family records what it changed. One per request, handed to
   * every family, and flushed by the request once its writes have settled.
   * A field rather than something each family builds for itself: a family
   * holding its own queue would record changes that nothing ever publishes,
   * and nothing about that would fail.
   */
  changes: ChangeRecorder;
}

/**
 * The server's implementation of the contract, assembled per request from
 * one module per family. The return annotation is the guarantee: a method
 * added to `LykeionApi` with nothing implementing it fails `typecheck` here
 * rather than at the first call.
 *
 * The absent family goes first, and everything with a real implementation
 * overrides it by spread order. That ordering is what lets this object
 * satisfy the contract from the outset instead of being cast into shape:
 * a method nobody has written yet answers honestly rather than being
 * missing, and the compiler is telling the truth the whole way through.
 */
export function createWorkspaceApi(deps: Deps): LykeionApi {
  return {
    ...absentApi(deps),
    async coreInfo() {
      return { name: "lykeion-server", version: "0.1.0" };
    },
    ...accountApi(deps),
    ...studiesApi(deps),
    ...tasksApi(deps),
    ...taskNamingApi(deps),
    ...machinesApi(deps),
    ...sessionsApi(deps),
    ...kernelsApi(deps),
    ...settingsApi(deps),
    ...configSurfaceApi(deps),
  };
}
