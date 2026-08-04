import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Row, SqlValue, Store } from "./store";

/**
 * `SqlValue` has no BLOB member, and there is no correct way to force one
 * into it: truncating to bytes-as-text is lossy and irreversible, and
 * silently returning the raw bytes would just move the failure to whatever
 * reads the field next. Refusing loudly, at the one place every row passes
 * through, is the only option that doesn't corrupt data.
 */
function narrow(raw: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v instanceof Uint8Array)
      throw new Error(`column "${k}" is a BLOB, which this store does not support`);
    out[k] = (v ?? null) as SqlValue;
  }
  return out;
}

/**
 * One file, write-ahead logging, foreign keys enforced. WAL is what lets a
 * handful of researchers write concurrently without blocking each other's
 * reads, and it is the reason a single file is enough for a lab.
 */
export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  let depth = 0;

  return {
    all(sql, params = []) {
      return db.prepare(sql).all(...params).map((r) => narrow(r as Record<string, unknown>));
    },
    get(sql, params = []) {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? undefined : narrow(row as Record<string, unknown>);
    },
    run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    tx(fn) {
      // A nested call opens its own SAVEPOINT rather than joining the outer
      // transaction: SQLite supports real nesting through
      // SAVEPOINT/RELEASE/ROLLBACK TO, and a write path composed of two
      // smaller write paths must be able to discard the inner one on its own
      // — an inner failure the outer caller catches and recovers from must
      // not silently commit the inner work anyway.
      const level = depth + 1;
      const savepoint = `sp_${level}`;
      // `depth` is only advanced once BEGIN/SAVEPOINT has actually
      // succeeded. If it throws — the one realistic case is a stray BEGIN
      // left open by something outside this method — the failure must not
      // wedge every later call onto the fast, transaction-free "nested"
      // path forever.
      if (level === 1) db.exec("BEGIN");
      else db.exec(`SAVEPOINT ${savepoint}`);
      depth = level;
      try {
        const out = fn();
        if (level === 1) db.exec("COMMIT");
        else db.exec(`RELEASE ${savepoint}`);
        depth = level - 1;
        return out;
      } catch (err) {
        try {
          if (level === 1) db.exec("ROLLBACK");
          else {
            db.exec(`ROLLBACK TO ${savepoint}`);
            db.exec(`RELEASE ${savepoint}`);
          }
        } catch (rollbackFailure) {
          // SQLite can end the transaction itself before this runs — on
          // SQLITE_FULL or an I/O error, for instance — in which case
          // ROLLBACK has nothing to roll back and raises its own, unrelated
          // error. The body's failure is what the caller needs explained, so
          // that stays the error thrown; the rollback's is attached rather
          // than dropped, because recovery having failed too is worth
          // knowing on the occasions it is not the harmless case.
          if (err instanceof Error && err.cause === undefined)
            err.cause = rollbackFailure;
        }
        depth = level - 1;
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}
