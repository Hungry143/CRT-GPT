import { Pool, type PoolConfig } from 'pg';
import { redactSensitiveText } from '@/server/marketData/adapter';
import type { PgQueryExecutor } from '@/server/marketData/candleStore';

export interface ManagedPgExecutor extends PgQueryExecutor {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const VALID_POSTGRES_SCHEMES = new Set(['postgres:', 'postgresql:']);

/**
 * Validates that a configured DATABASE_URL uses an explicit postgres:// or postgresql:// scheme.
 */
export function isValidPostgresConnectionString(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      VALID_POSTGRES_SCHEMES.has(parsed.protocol) &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Builds a bounded pg.Pool configuration from a server-only DATABASE_URL.
 * Never logs or exposes credentials in errors.
 */
export function buildPgPoolConfig(databaseUrl: string): PoolConfig {
  const parsed = new URL(databaseUrl);
  const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
  const requireSsl =
    sslMode === 'require' ||
    sslMode === 'verify-ca' ||
    sslMode === 'verify-full';

  return {
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    ...(requireSsl ? { ssl: { rejectUnauthorized: sslMode !== 'require' } } : {}),
  };
}

/**
 * Creates a bounded, server-only PostgreSQL executor backed by `pg.Pool`.
 */
export function createManagedPgExecutor(
  databaseUrl: string
): ManagedPgExecutor {
  if (!isValidPostgresConnectionString(databaseUrl)) {
    throw new Error('Invalid PostgreSQL DATABASE_URL scheme or host');
  }

  const pool = new Pool(buildPgPoolConfig(databaseUrl));
  let closed = false;

  // Prevent unhandled pool error events from crashing the Node process
  pool.on('error', () => {
    // Connection errors surface cleanly via query/ping fail-closed checks
  });

  return {
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[]
    ): Promise<{ rows: T[] }> {
      try {
        const res = await pool.query(sql, [...params]);
        return { rows: res.rows as T[] };
      } catch (err) {
        const rawMsg =
          err instanceof Error ? err.message : 'PostgreSQL query failed';
        throw new Error(redactSensitiveText(rawMsg, [databaseUrl]));
      }
    },

    async ping(): Promise<boolean> {
      if (closed) return false;
      try {
        await pool.query('SELECT 1 AS ok');
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await pool.end();
      } catch {
        // Ignore shutdown errors on already-terminated pools
      }
    },
  };
}
