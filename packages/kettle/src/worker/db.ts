/**
 * Database client using Durable Objects SQLite storage.
 * Uses workerd's built-in SQLite via the DO SQL API.
 */

import {
  DurableObjectSqliteClient,
  type DurableObjectStorage,
} from "./do-db.js"

export interface FetcherLike {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>
}

export interface DbBindings {
  // DO storage binding (injected by HonoDurableObject when enableSql = true)
  DO_STORAGE?: DurableObjectStorage
}

export interface Row {
  [key: string]: unknown
}

export interface ResultSet {
  columns: string[]
  rows: Row[]
  rowsAffected: number
  lastInsertRowid: bigint | number
}

export interface SqliteClient {
  execute(sql: string | { sql: string; args?: unknown[] }): Promise<ResultSet>
  batch(statements: (string | { sql: string; args?: unknown[] })[]): Promise<ResultSet[]>
  close(): void
}

export function getDb(env: DbBindings): SqliteClient {
  if (!env.DO_STORAGE?.sql) {
    throw new Error("Database not configured: DO_STORAGE.sql not available. Ensure enableSql = true in workerd config.")
  }

  return new DurableObjectSqliteClient(env.DO_STORAGE)
}
