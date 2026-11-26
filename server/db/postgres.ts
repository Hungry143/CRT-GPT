import { Pool, type PoolConfig } from 'pg';
import { redactSensitiveText } from '@/server/marketData/adapter';
import type { PgQueryExecutor } from '@/server/marketData/candleStore';

export interface ManagedPgExecutor extends PgQueryExecutor {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const VALID_POSTGRES_SCHEMES = new Set(['postgres:', 'postgresql:']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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

export function isLoopbackPostgresHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

/**
 * Builds a bounded, TLS-hardened `pg.Pool` configuration from server-only DATABASE_URL.
 *
 * Production TLS guarantees (`NODE_ENV === 'production'`):
 * - Non-loopback connections ALWAYS require TLS with strict certificate validation (`rejectUnauthorized: true`).
 * - `sslmode=no-verify`, `DATABASE_SSL_REJECT_UNAUTHORIZED=false`, or `sslmode=disable` on remote hosts
 *   fail closed by throwing a configuration error.
 * - `sslmode=require`, `verify-ca`, and `verify-full` ALWAYS enforce `rejectUnauthorized: true`
 *   (never silently downgrading `require` to disabled certificate verification).
 * - Optional custom root CA certificate may be supplied via `DATABASE_CA_CERT` (PEM string with `\n` or newlines).
 * - Strips `sslmode` from the passed connectionString when explicit `ssl` options are set so `pg` does not
 *   override our hardened TLS configuration.
 */
export function buildPgPoolConfig(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env
): PoolConfig {
  if (!isValidPostgresConnectionString(databaseUrl)) {
    throw new Error('Invalid PostgreSQL DATABASE_URL scheme or host');
  }

  const parsed = new URL(databaseUrl);
  const isProduction = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const isLoopback = isLoopbackPostgresHost(parsed.hostname);
  const rawSslMode = (
    parsed.searchParams.get('sslmode') ??
    env.PGSSLMODE ??
    ''
  )
    .trim()
    .toLowerCase();
  const explicitInsecureFlag =
    env.DATABASE_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase() === 'false';
  const rawCa = env.DATABASE_CA_CERT?.trim();
  const ca = rawCa ? rawCa.replace(/\\n/g, '\n') : undefined;

  if (isProduction) {
    if (rawSslMode === 'no-verify' || explicitInsecureFlag) {
      throw new Error(
        'Insecure PostgreSQL TLS configuration (disabled certificate verification) is forbidden in production'
      );
    }
    if (rawSslMode === 'disable' && !isLoopback) {
      throw new Error(
        'Unencrypted PostgreSQL connections (sslmode=disable) to remote hosts are forbidden in production'
      );
    }
  }

  let sslConfig: PoolConfig['ssl'] = undefined;

  if (rawSslMode === 'disable') {
    sslConfig = false;
  } else if (rawSslMode === 'no-verify' || explicitInsecureFlag) {
    // Only reachable outside production (development/test self-signed local servers)
    sslConfig = { rejectUnauthorized: false, ...(ca ? { ca } : {}) };
  } else if (
    rawSslMode === 'require' ||
    rawSslMode === 'verify-ca' ||
    rawSslMode === 'verify-full' ||
    rawSslMode === 'prefer' ||
    (isProduction && !isLoopback)
  ) {
    sslConfig = {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
    };
  } else if (ca) {
    sslConfig = {
      rejectUnauthorized: true,
      ca,
    };
  }

  // Strip sslmode from connectionString when explicit ssl object is supplied so pg-connection-string
  // cannot weaken rejectUnauthorized back to false.
  let sanitizedConnectionString = databaseUrl;
  if (sslConfig !== undefined) {
    const cleanedUrl = new URL(databaseUrl);
    cleanedUrl.searchParams.delete('sslmode');
    sanitizedConnectionString = cleanedUrl.toString();
  }

  return {
    connectionString: sanitizedConnectionString,
    max: 5,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    ...(sslConfig !== undefined ? { ssl: sslConfig } : {}),
  };
}

/**
 * Creates a bounded, server-only PostgreSQL executor backed by `pg.Pool`.
 */
export function createManagedPgExecutor(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env
): ManagedPgExecutor {
  const poolConfig = buildPgPoolConfig(databaseUrl, env);
  const pool = new Pool(poolConfig);
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
