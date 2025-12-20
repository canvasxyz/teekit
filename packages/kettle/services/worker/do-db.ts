/**
 * Durable Objects SQLite adapter that implements the SqliteClient interface.
 * This allows transparent switching between HTTP-based SQLCipher and
 * workerd's built-in DO SQLite storage.
 */

import type { SqliteClient, ResultSet, Row } from "./db.js"

export interface SqlStorageCursor {
  toArray(): Record<string, unknown>[]
  one(): Record<string, unknown>
  raw(): Iterator<unknown[]>
  readonly columnNames: string[]
  readonly rowsRead: number
  readonly rowsWritten: number
}

export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlStorageCursor
  readonly databaseSize: number
}

export interface DurableObjectStorage {
  sql?: SqlStorage
  transactionSync?<T>(fn: () => T): T
}

/**
 * Convert ?1, ?2 style parameters (libsql format) to positional ? style (DO SQL format).
 * The args array should already be in order, so we just need to replace the placeholders.
 */
function normalizeParams(sql: string): string {
  return sql.replace(/\?(\d+)/g, "?")
}

/**
 * SQLite client implementation using Durable Objects storage.sql API.
 * Provides the same interface as the HTTP-based SimpleSqliteClient.
 */
export class DurableObjectSqliteClient implements SqliteClient {
  private sql: SqlStorage
  private transactionSync: <T>(fn: () => T) => T

  constructor(storage: DurableObjectStorage) {
    if (!storage.sql) {
      throw new Error("DurableObjectStorage.sql is not available")
    }
    if (!storage.transactionSync) {
      throw new Error("DurableObjectStorage.transactionSync is not available")
    }
    this.sql = storage.sql
    this.transactionSync = storage.transactionSync.bind(storage)
  }

  async execute(
    sqlOrStatement: string | { sql: string; args?: unknown[] },
  ): Promise<ResultSet> {
    const sql =
      typeof sqlOrStatement === "string" ? sqlOrStatement : sqlOrStatement.sql
    const args =
      typeof sqlOrStatement === "string" ? [] : (sqlOrStatement.args ?? [])

    const normalizedSql = normalizeParams(sql)

    // Normalize undefined to null for SQLite compatibility
    const normalizedArgs = args.map((arg) => (arg === undefined ? null : arg))

    const cursor = this.sql.exec(normalizedSql, ...normalizedArgs)
    const rows = cursor.toArray() as Row[]

    // Get lastInsertRowid and changes via SQLite functions
    // These must be called immediately after the statement
    const lastRowIdCursor = this.sql.exec(
      "SELECT last_insert_rowid() as id",
    )
    const lastRowId = lastRowIdCursor.one()

    const changesCursor = this.sql.exec("SELECT changes() as c")
    const changesResult = changesCursor.one()

    return {
      columns: cursor.columnNames,
      rows,
      rowsAffected: (changesResult.c as number) ?? 0,
      lastInsertRowid: (lastRowId.id as number) ?? 0,
    }
  }

  async batch(
    statements: (string | { sql: string; args?: unknown[] })[],
  ): Promise<ResultSet[]> {
    const results: ResultSet[] = []

    // Execute all statements within a transaction for atomicity
    this.transactionSync(() => {
      for (const stmt of statements) {
        const sql = typeof stmt === "string" ? stmt : stmt.sql
        const args = typeof stmt === "string" ? [] : (stmt.args ?? [])

        const normalizedSql = normalizeParams(sql)
        const normalizedArgs = args.map((arg) =>
          arg === undefined ? null : arg,
        )

        const cursor = this.sql.exec(normalizedSql, ...normalizedArgs)
        const rows = cursor.toArray() as Row[]

        const lastRowIdCursor = this.sql.exec(
          "SELECT last_insert_rowid() as id",
        )
        const lastRowId = lastRowIdCursor.one()

        const changesCursor = this.sql.exec("SELECT changes() as c")
        const changesResult = changesCursor.one()

        results.push({
          columns: cursor.columnNames,
          rows,
          rowsAffected: (changesResult.c as number) ?? 0,
          lastInsertRowid: (lastRowId.id as number) ?? 0,
        })
      }
    })

    return results
  }

  close(): void {
    // No-op for DO storage - lifecycle managed by workerd
  }

  /**
   * Get the current database size in bytes.
   * Only available with DO storage.
   */
  getDatabaseSize(): number {
    return this.sql.databaseSize
  }
}
