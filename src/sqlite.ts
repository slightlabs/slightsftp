/**
 * SQLite through Node's built-in node:sqlite (no native module to rebuild
 * for Electron or each platform), behind the small run()/exec() surface the
 * code used with sql.js:
 *   run(sql, params?)  executes a statement (or a script without params)
 *   exec(sql, params?) returns [{ columns, values }], or [] for no rows
 *
 * Unlike sql.js, which kept the database in memory and rewrote the whole
 * file after each change, every statement is written to disk as it runs
 * (WAL journal), so a crash loses at most the statement in progress.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DatabaseSync as DatabaseSyncType, StatementSync, SQLInputValue } from 'node:sqlite';

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

/** node:sqlite, without its one-time "experimental feature" warning. */
function sqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: any[]) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite is an experimental feature/.test(String(text))) return;
    return (emitWarning as any).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteModule = require('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqliteModule;
}

export type SqlValue = string | number | bigint | Uint8Array | null;
export interface QueryResult {
  columns: string[];
  values: SqlValue[][];
}

/** sql.js bound booleans as 1/0 and undefined as NULL; node:sqlite refuses both. */
function bindable(params: readonly unknown[]): SQLInputValue[] {
  return params.map(p => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p as SQLInputValue;
  });
}

export class SqliteDatabase {
  private readonly db: DatabaseSyncType;

  /**
   * @param file a path, or ':memory:'
   * @param options.readOnly open without write access (validating a backup)
   * @param options.foreignKeys enforce foreign keys (the default)
   */
  constructor(readonly file: string, options: { readOnly?: boolean; foreignKeys?: boolean } = {}) {
    const { DatabaseSync } = sqlite();
    this.db = new DatabaseSync(file, { readOnly: !!options.readOnly, enableForeignKeyConstraints: options.foreignKeys !== false });
    if (!options.readOnly) {
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (file !== ':memory:') {
        // WAL: readers don't block the writer, and commits are cheap appends;
        // NORMAL is crash-safe in WAL mode (a power cut may lose the last commit)
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
      }
    }
  }

  run(sql: string, params?: readonly unknown[]): void {
    if (!params || params.length === 0) {
      this.db.exec(sql); // may be a script of several statements
      return;
    }
    this.db.prepare(sql).run(...bindable(params));
  }

  exec(sql: string, params: readonly unknown[] = []): QueryResult[] {
    const statement = this.db.prepare(sql);
    const rows = statement.all(...bindable(params)) as Record<string, SqlValue>[];
    if (rows.length === 0) return [];
    const columns = columnNames(statement, rows[0]);
    return [{ columns, values: rows.map(row => columns.map(c => row[c])) }];
  }

  /** Run fn in one transaction: all of its changes are written, or none. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * A consistent copy of the whole database as SQLite file bytes, after
   * running `scrub` statements on the copy (never on this database).
   */
  serialize(scrub: string[] = []): Buffer {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slightsftp-export-'));
    const copy = path.join(dir, 'copy.db');
    try {
      this.db.prepare('VACUUM INTO ?').run(copy);
      if (scrub.length) {
        const { DatabaseSync } = sqlite();
        const target = new DatabaseSync(copy);
        try {
          for (const sql of scrub) target.exec(sql);
          target.exec('VACUUM'); // leave no trace of the removed rows in free pages
        } finally {
          target.close();
        }
      }
      return fs.readFileSync(copy);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  close(): void {
    this.db.close();
  }
}

function columnNames(statement: StatementSync, firstRow: Record<string, unknown>): string[] {
  // StatementSync.columns() keeps the select order even for integer-like names
  const described = typeof (statement as any).columns === 'function' ? (statement as any).columns() : null;
  if (Array.isArray(described) && described.length) return described.map((c: { name: string }) => c.name);
  return Object.keys(firstRow);
}
