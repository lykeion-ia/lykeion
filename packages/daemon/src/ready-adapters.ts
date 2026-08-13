import type { AdapterLaunch } from "./agent-registry";

/**
 * The adapters this machine has actually vetted, held between the probe that
 * vetted them and the run that launches one.
 *
 * Its own module rather than a variable in `main.ts` for two reasons. A run is
 * launched through exactly what a probe proved could handshake, and that
 * guarantee is worth a test — which module-level state in an entry point
 * cannot have. And the map is replaced wholesale on every cycle rather than
 * merged into, so an adapter uninstalled between cycles stops being launchable
 * rather than lingering as a name nothing can start any more.
 */
let vetted: ReadonlyMap<string, AdapterLaunch> = new Map();

export function rememberAdapters(next: ReadonlyMap<string, AdapterLaunch>): void {
  // Copied in, for the same reason `adapterFor` copies out: what a probe
  // vetted must not change afterwards because a caller still held the map it
  // passed.
  vetted = new Map(next);
}

/**
 * Which program speaks ACP for a given agent id, and how to start it.
 *
 * The spec returned here is the one `probeAdapter` built and handshook through
 * — resolved path and declared arguments together — rather than one rebuilt
 * from a command name. That is what makes "a run is never launched through a
 * different program than the one that was checked" true by construction: there
 * is one object, built where the adapter resolved, and no second place for a
 * caller to reassemble it differently.
 *
 * An agent no cycle has vetted answers nothing, and `runs.ts` reports that as
 * the run's own refusal rather than launching a program probing never checked.
 */
export function adapterFor(agent: string): { command: string; args: string[] } | undefined {
  const launch = vetted.get(agent);
  return launch === undefined ? undefined : { command: launch.command, args: [...launch.args] };
}
