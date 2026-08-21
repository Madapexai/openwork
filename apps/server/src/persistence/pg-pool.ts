// SPDX-License-Identifier: MIT
// Stub Postgres pool implementation for the phase-1-core governance PG migration.
// Real implementation pending — all governance PG paths return empty no-ops so
// Electron/server tsc passes without a real Postgres connection.
//
// NOTE: The returned row accessor is intentionally dual-shaped — both `.rows`
// and direct array indexing work — because different call sites use different
// patterns (some use `result.rows[0]`, some use `result.map`).

export type PgRow = Record<string, unknown>

type QueryResult = PgRow[] & { rows: PgRow[] }

function makeRows(rows: PgRow[] = []): QueryResult {
  return Object.assign(rows, { rows }) as QueryResult
}

export type PoolClient = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  release: () => void;
}

export type PgPool = {
  connect: () => Promise<PoolClient>;
  end: () => Promise<void>;
}

export type PgInstance = {
  q: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  pool: () => Promise<PgPool>;
  end: () => Promise<void>;
}

export function createPgPool(
  _connectionString?: string,
  _migrations?: string[],
): PgInstance {
  const empty: QueryResult = makeRows([])
  const pool: PgPool = {
    connect: () => Promise.resolve({
      query: () => Promise.resolve(empty),
      release: () => {},
    }),
    end: () => Promise.resolve(),
  }
  return {
    q: () => Promise.resolve(empty),
    pool: () => Promise.resolve(pool),
    end: () => Promise.resolve(),
  }
}

export function withPgTransaction(
  _pool: PgPool | undefined,
  cb: (client: PoolClient) => Promise<void>,
): Promise<void> {
  return cb({
    query: () => Promise.resolve(makeRows([])),
    release: () => {},
  })
}
