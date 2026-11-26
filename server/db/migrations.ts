import type { PgQueryExecutor } from '@/server/marketData/candleStore';

export interface PostgresMigrationDefinition {
  version: string;
  name: string;
  statements: readonly string[];
}

export interface MigrationRunResult {
  appliedVersions: string[];
  skippedVersions: string[];
}

const CREATE_SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/**
 * Versioned, idempotent PostgreSQL schema migrations for Stage 2A market-data persistence.
 * Mirrors `server/db/migrations/001_stage2a_market_data.sql` in discrete statements so both
 * pooled drivers and transactional executors can apply migrations deterministically.
 */
export const STAGE_2A_MIGRATIONS: readonly PostgresMigrationDefinition[] = [
  {
    version: '001_stage2a_market_data',
    name: 'Create normalized_candles, candle_revision_events, and market_feed_checkpoints tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS normalized_candles (
        source_candle_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_symbol TEXT NOT NULL,
        granularity TEXT NOT NULL,
        price_basis TEXT NOT NULL,
        open_time_utc TIMESTAMPTZ NOT NULL,
        close_time_utc TIMESTAMPTZ NOT NULL,
        open_price NUMERIC NOT NULL,
        high_price NUMERIC NOT NULL,
        low_price NUMERIC NOT NULL,
        close_price NUMERIC NOT NULL,
        volume INTEGER NULL,
        complete BOOLEAN NOT NULL,
        source_retrieved_at_utc TIMESTAMPTZ NOT NULL,
        CONSTRAINT normalized_candles_natural_key UNIQUE (
          provider,
          provider_symbol,
          price_basis,
          granularity,
          open_time_utc
        ),
        CONSTRAINT normalized_candles_ohlc_positive CHECK (
          open_price > 0 AND high_price > 0 AND low_price > 0 AND close_price > 0
        ),
        CONSTRAINT normalized_candles_ohlc_bounds CHECK (
          high_price >= open_price
          AND high_price >= close_price
          AND high_price >= low_price
          AND low_price <= open_price
          AND low_price <= close_price
        ),
        CONSTRAINT normalized_candles_time_order CHECK (
          close_time_utc > open_time_utc
        )
      )`,
      `CREATE INDEX IF NOT EXISTS idx_normalized_candles_lookup
        ON normalized_candles (granularity, provider_symbol, open_time_utc DESC)
        WHERE complete = TRUE`,
      `CREATE TABLE IF NOT EXISTS candle_revision_events (
        id BIGSERIAL PRIMARY KEY,
        source_candle_id TEXT NOT NULL,
        detected_at_utc TIMESTAMPTZ NOT NULL,
        changed_fields TEXT[] NOT NULL,
        previous_close NUMERIC NOT NULL,
        revised_close NUMERIC NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_candle_revision_events_candle
        ON candle_revision_events (source_candle_id, detected_at_utc DESC)`,
      `CREATE TABLE IF NOT EXISTS market_feed_checkpoints (
        checkpoint_key TEXT PRIMARY KEY,
        adapter_name TEXT NOT NULL,
        provider_symbol TEXT NULL,
        state TEXT NOT NULL,
        provider_verified BOOLEAN NOT NULL DEFAULT FALSE,
        last_successful_request_utc TIMESTAMPTZ NULL,
        last_provider_candle_open_utc TIMESTAMPTZ NULL,
        last_complete_candle_close_utc TIMESTAMPTZ NULL,
        missing_bar_count INTEGER NULL,
        duplicate_bar_count INTEGER NULL,
        reason_code TEXT NULL,
        warnings TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
  },
  {
    version: '002_checkpoint_identity',
    name: 'Add configuration identity columns to market_feed_checkpoints and scoped candle lookup index',
    statements: [
      `ALTER TABLE market_feed_checkpoints
        ADD COLUMN IF NOT EXISTS config_identity_hash TEXT NULL,
        ADD COLUMN IF NOT EXISTS provider TEXT NULL,
        ADD COLUMN IF NOT EXISTS price_basis TEXT NULL,
        ADD COLUMN IF NOT EXISTS policy_version TEXT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_normalized_candles_scoped
        ON normalized_candles (provider, provider_symbol, price_basis, granularity, open_time_utc DESC)
        WHERE complete = TRUE`,
    ],
  },
];

/**
 * Runs all pending Stage 2A PostgreSQL migrations idempotently.
 * Uses strictly parameterized queries when recording migration metadata.
 */
export async function runPostgresMigrations(
  executor: PgQueryExecutor,
  migrations: readonly PostgresMigrationDefinition[] = STAGE_2A_MIGRATIONS
): Promise<MigrationRunResult> {
  await executor.query(CREATE_SCHEMA_MIGRATIONS_SQL, []);

  const appliedRes = await executor.query<{ version: string }>(
    `SELECT version FROM schema_migrations ORDER BY version ASC`,
    []
  );
  const alreadyApplied = new Set(appliedRes.rows.map((r) => r.version));

  const appliedVersions: string[] = [];
  const skippedVersions: string[] = [];

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.version)) {
      skippedVersions.push(migration.version);
      continue;
    }

    for (const statement of migration.statements) {
      await executor.query(statement, []);
    }

    await executor.query(
      `INSERT INTO schema_migrations (version, name, applied_at_utc)
       VALUES ($1, $2, NOW())
       ON CONFLICT (version) DO NOTHING`,
      [migration.version, migration.name]
    );
    appliedVersions.push(migration.version);
  }

  return { appliedVersions, skippedVersions };
}
