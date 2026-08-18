import type { Store } from "./store";
import type { KernelEnvDeclaration, Language } from "@lykeion/api";

export interface DeclareInput {
  name: string;
  language: Language;
  manager: "uv" | "conda";
  packages: string[];
  /** Absent for a declaration nobody made — see `KernelEnvDeclaration.createdBy`
   *  (R14). `seedLabContent`'s starter is the one caller that omits this. */
  createdBy?: string;
  createdTs: number;
}

function rowToEnv(row: Record<string, unknown>): KernelEnvDeclaration {
  return {
    name: row.name as string,
    language: row.language as Language,
    manager: row.manager as "uv" | "conda",
    packages: JSON.parse(row.packages as string) as string[],
    ...(row.created_by === null ? {} : { createdBy: row.created_by as string }),
    createdTs: row.created_ts as number,
    lockRevision: row.lock_revision as number,
  };
}

export function environmentStore(store: Store) {
  return {
    declare(input: DeclareInput): KernelEnvDeclaration {
      store.run(
        `INSERT INTO kernel_envs
           (name, language, manager, packages, created_by, created_ts, lock_revision)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [
          input.name, input.language, input.manager,
          JSON.stringify(input.packages), input.createdBy ?? null, input.createdTs,
        ],
      );
      return this.get(input.name)!;
    },

    list(): KernelEnvDeclaration[] {
      return store.all(`SELECT * FROM kernel_envs ORDER BY name`).map(rowToEnv);
    },

    get(name: string): KernelEnvDeclaration | undefined {
      const row = store.get(`SELECT * FROM kernel_envs WHERE name = ?`, [name]);
      return row === undefined ? undefined : rowToEnv(row);
    },

    /**
     * The declaration whose name is this one but for its case, where there is
     * one — `get` with the collation a machine's FILESYSTEM has rather than
     * the one SQLite's `TEXT PRIMARY KEY` has.
     *
     * The two disagree, and the disagreement is a silent data loss. SQLite's
     * default collation is BINARY, so `python` and `Python` are two rows;
     * seatbelt is the only sandbox backend this phase ships, so every machine
     * is macOS, whose default APFS volume is case-insensitive. Two rows, one
     * `<workDir>/envs/<name>` directory — and `materializeEnvironment` runs
     * `uv venv <workspace> --clear`, which removes everything already at the
     * target path. The second declaration's first build deletes the first
     * one's, `readEnvStatus` then reads the survivor's marker under the other
     * name, and every kernel bound to either runs the same interpreter.
     *
     * `NOCASE` folds ASCII only, which is exactly the right fold here and not
     * an approximation: `BUILDABLE_NAME` admits only `[A-Za-z0-9_-]`, so
     * every name this can be asked about is ASCII, and on that alphabet
     * SQLite's fold and APFS's agree. A name outside it never reaches a
     * declaration at all.
     *
     * Only `declareEnvironment` asks. Every other read stays exact: a lab
     * that already holds a colliding pair (declared before this check
     * existed) must keep answering for both of them by the names it has.
     */
    getIgnoringCase(name: string): KernelEnvDeclaration | undefined {
      const row = store.get(`SELECT * FROM kernel_envs WHERE name = ? COLLATE NOCASE`, [name]);
      return row === undefined ? undefined : rowToEnv(row);
    },

    /**
     * Adds packages to a declaration and answers with the list it now holds.
     *
     * APPENDS, never replaces. `manage_packages` is a tool that ADDS, and a
     * call that replaced would silently uninstall everything it did not
     * happen to mention — an agent asking for `scanpy` would take `anndata`
     * out of every machine in the lab.
     *
     * De-duplicated, keeping the order the declaration already had and
     * appending genuinely-new names in the order they were asked for: a list
     * that grew a second `scanpy` every time one was asked for would be a
     * declaration whose text changes while what it describes does not, and
     * `kernelEnvSetup`'s own comparison would then read that as a reason to
     * re-pin the whole lab.
     *
     * A call adding only names already declared is not an error — it is the
     * state the caller asked for, already reached — and it writes NOTHING:
     * the row is left exactly as it was, so nothing downstream can read a
     * no-op as a change. `added` is what makes that visible to the caller.
     */
    addPackages(name: string, packages: string[]): { packages: string[]; added: string[] } {
      return store.tx(() => {
        const declaration = this.get(name);
        // Refused here, by name, rather than carried as a precondition the
        // one caller that exists happens to satisfy. This method is exported
        // and any later caller can reach it; a non-null assertion would give
        // that caller a `TypeError` about a property of `undefined` instead
        // of the name it got wrong.
        if (declaration === undefined)
          throw new Error(`this lab declares no environment named ${name}`);
        const held = new Set(declaration.packages);
        const added: string[] = [];
        for (const wanted of packages) {
          if (held.has(wanted)) continue;
          held.add(wanted);
          added.push(wanted);
        }
        if (added.length === 0) return { packages: declaration.packages, added };
        const now = [...declaration.packages, ...added];
        store.run(`UPDATE kernel_envs SET packages = ? WHERE name = ?`, [
          JSON.stringify(now),
          name,
        ]);
        return { packages: now, added };
      });
    },

    /** Writes a resolved lockfile and returns the revision it became.
     *
     *  `requestedPackages` is the list this lab asked that machine to resolve
     *  FROM — remembered beside the text it produced, so that a later setup
     *  can tell a pin that still describes the declaration from one the
     *  declaration has since grown past. `undefined` writes SQL NULL, which
     *  is a pin this lab cannot name the request for rather than one resolved
     *  from nothing (see migration 28). */
    writeLock(
      name: string,
      lockfile: string,
      ts: number,
      requestedPackages?: string[],
    ): number {
      const next = ((store.get(
        `SELECT lock_revision AS r FROM kernel_envs WHERE name = ?`, [name],
      )?.r as number | undefined) ?? 0) + 1;
      store.run(
        `INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts, requested_packages)
         VALUES (?, ?, ?, ?, ?)`,
        [name, next, lockfile, ts, requestedPackages === undefined ? null : JSON.stringify(requestedPackages)],
      );
      store.run(`UPDATE kernel_envs SET lock_revision = ? WHERE name = ?`, [next, name]);
      return next;
    },

    readLock(name: string, revision: number): string | undefined {
      return store.get(
        `SELECT lockfile FROM kernel_env_locks WHERE name = ? AND revision = ?`,
        [name, revision],
      )?.lockfile as string | undefined;
    },

    /** What one pinned revision was resolved from, or `undefined` where this
     *  lab cannot say — a row written before migration 28 held one.
     *
     *  Callers ask `readLock` FIRST and treat a missing row as its own,
     *  harder failure: a revision this lab points at and holds no text for
     *  is a broken store, while a row that simply cannot name its request is
     *  an old one, and only the second of those is a reason to resolve. */
    readLockRequest(name: string, revision: number): string[] | undefined {
      const raw = store.get(
        `SELECT requested_packages AS p FROM kernel_env_locks WHERE name = ? AND revision = ?`,
        [name, revision],
      )?.p as string | null | undefined;
      if (raw === null || raw === undefined) return undefined;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : undefined;
    },

    /** A hard delete, of the declaration and every lockfile revision it
     *  wrote — not a tombstone. Locks first: the FK from `kernel_env_locks`
     *  to `kernel_envs(name)` means the declaration row cannot go first.
     *  Clearing both is also what lets the same name be declared again
     *  later without either row colliding with what its predecessor left
     *  behind — see `environments.test.ts`'s recreate case. */
    remove(name: string): void {
      store.run(`DELETE FROM kernel_env_locks WHERE name = ?`, [name]);
      store.run(`DELETE FROM kernel_envs WHERE name = ?`, [name]);
    },
  };
}
