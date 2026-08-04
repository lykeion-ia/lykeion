/**
 * The values that cross the storage boundary. Deliberately narrow: whatever
 * database sits underneath, nothing above this line learns its types.
 */
export type SqlValue = string | number | null;

export type Row = Record<string, SqlValue>;

/**
 * The whole storage surface — four methods, and SQL. The engine is
 * replaceable because nothing above depends on anything but this; SQL itself
 * is not the thing being abstracted, the driver is.
 */
export interface Store {
  all(sql: string, params?: SqlValue[]): Row[];
  get(sql: string, params?: SqlValue[]): Row | undefined;
  run(sql: string, params?: SqlValue[]): void;
  /** Run `fn` inside a transaction, rolling back whole if it throws. */
  tx<T>(fn: () => T): T;
  close(): void;
}
