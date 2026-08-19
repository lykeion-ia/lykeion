import { access, constants } from "node:fs/promises";
import { delimiter, join, sep } from "node:path";

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

/**
 * Whether `candidate` is a file this machine can run as a command. POSIX
 * marks that with the executable bit; Windows has none, so a file simply
 * existing under one of the conventional executable extensions counts.
 */
export async function isRunnable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches `pathValue` the way a shell's own command lookup would, but
 * without ever invoking a shell: split on the platform separator, and for
 * each directory, the first candidate that exists and is runnable wins.
 *
 * Shared rather than owned by `probe.ts` alone: `agent-auth.ts` needs the
 * same answer for the same reason — a boundary rendered against a bare
 * command name (`"claude"`) never covers the symlink it actually resolves
 * to (see `confine()` in `sandbox.ts`, and `probe.ts`'s `readVersion`, which
 * always confines the *resolved* path rather than the bare one). One
 * implementation means the two callers cannot quietly drift apart on how a
 * command is found.
 */
export async function resolveOnPath(command: string, pathValue: string): Promise<string | undefined> {
  // A command with a separator in it is a PATH, and no shell searches PATH
  // for one — `./x` and `/opt/x` name a file directly. This function said it
  // resolved "the way a shell's own command lookup would" while doing the
  // opposite for that case: `join(dir, "/abs/path")` yields `dir/abs/path`,
  // which exists nowhere, so every absolute command resolved to `undefined`.
  //
  // Found by the first end-to-end R build. `runConfinedIn` answers an
  // unresolvable command with `{ok: false}` and two EMPTY streams, so a conda
  // build asking its own `bin/Rscript` for a version failed with nothing to
  // say about why — the error named the R version it could not read and had
  // no output to quote, because the interpreter was never run.
  //
  // The catalogue's adapters are still bare names and a test still asserts
  // it; what changes here is what happens to a caller that legitimately
  // holds a full path to something it built itself.
  if (command.includes(sep) || command.includes("/"))
    return (await isRunnable(command)) ? command : undefined;
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? WINDOWS_EXTENSIONS.map((ext) => join(dir, command + ext))
        : [join(dir, command)];
    for (const candidate of candidates) {
      if (await isRunnable(candidate)) return candidate;
    }
  }
  return undefined;
}
