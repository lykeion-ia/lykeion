import type { LykeionApi } from "@lykeion/api";
import type { Store } from "../store/store";
import type { Actor } from "../auth";
import type { ServerConfig } from "../config";
import type { Channel } from "../channel";
import type { ChangeRecorder } from "./changes";
import { absentApi } from "./absent";
import { accountApi } from "./account";
import { configSurfaceApi } from "./config-surface";
import { settingsApi } from "./settings";
import { studiesApi } from "./studies";
import { tasksApi } from "./tasks";
import { runtimesApi } from "./runtimes";

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
    ...runtimesApi(deps),
    ...settingsApi(deps),
    ...configSurfaceApi(deps),
  };
}
