import type {
  CandleRevisionEvent,
  HistoryPersistenceState,
  MarketDataProviderState,
  MarketGranularity,
  NormalizedCandle,
  PriceBasis,
} from '@/shared/contracts/marketData';
import {
  buildDeterministicCandleKey,
  buildScopedCandleStorageKey,
} from '@/shared/utils/candleValidator';
import {
  createManagedPgExecutor,
  isValidPostgresConnectionString,
  type ManagedPgExecutor,
} from '@/server/db/postgres';
import { runPostgresMigrations } from '@/server/db/migrations';
import { redactSensitiveText } from '@/server/marketData/adapter';

export interface CandleUpsertSummary {
  inserted: number;
  unchanged: number;
  revisionsDetected: CandleRevisionEvent[];
}

export const LEGACY_UNSCOPED_CONFIG_IDENTITY = 'legacy_unscoped';

export interface CandleStorageScope {
  configIdentityHash: string;
  providerEnv?: string | null;
  accountScopeHash?: string | null;
}

export interface CandleQueryOptions {
  configIdentityHash?: string;
  provider?: string;
  providerEnv?: string | null;
  accountScopeHash?: string | null;
  providerSymbol?: string;
  priceBasis?: PriceBasis;
  granularity: MarketGranularity;
  limit: number;
}

export interface FeedCheckpointRecord {
  checkpointKey: string;
  configIdentityHash: string | null;
  provider: string | null;
  providerEnv?: string | null;
  accountScopeHash?: string | null;
  priceBasis: PriceBasis | null;
  policyVersion: string | null;
  adapterName: string;
  providerSymbol: string | null;
  state: MarketDataProviderState;
  providerVerified: boolean;
  lastSuccessfulRequestUtc: string | null;
  lastProviderCandleOpenUtc: string | null;
  lastCompleteCandleCloseUtc: string | null;
  missingBarCount: number | null;
  duplicateBarCount: number | null;
  reasonCode: string | null;
  warnings: string[];
  updatedAtUtc: string;
}

export const DEFAULT_FEED_CHECKPOINT_KEY = 'XAUUSD:primary';

export function buildScopedCheckpointKey(configIdentityHash: string): string {
  return `XAUUSD:${configIdentityHash}`;
}

/**
 * Provider-neutral completed-candle repository contract.
 * Never persists production history to Next.js ephemeral container filesystem or browser localStorage.
 */
export interface CandleStore {
  getPersistenceState(): HistoryPersistenceState;
  ensureReady(): Promise<HistoryPersistenceState>;
  getLastPersistenceError(): string | null;
  upsertCandles(
    candles: readonly NormalizedCandle[],
    detectedAtUtc?: string,
    scope?: CandleStorageScope
  ): Promise<CandleUpsertSummary>;
  getCompletedCandles(options: CandleQueryOptions): Promise<NormalizedCandle[]>;
  getLatestCompletedCandle(
    granularity: MarketGranularity,
    scope?: Omit<CandleQueryOptions, 'granularity' | 'limit'>
  ): Promise<NormalizedCandle | null>;
  getRevisionEvents(configIdentityHash?: string): Promise<CandleRevisionEvent[]>;
  saveFeedCheckpoint(checkpoint: FeedCheckpointRecord): Promise<void>;
  getFeedCheckpoint(
    checkpointKey?: string
  ): Promise<FeedCheckpointRecord | null>;
  close(): Promise<void>;
}

function diffCandleFields(
  prev: NormalizedCandle,
  next: NormalizedCandle
): string[] {
  const fields: Array<keyof NormalizedCandle> = [
    'open',
    'high',
    'low',
    'close',
    'volume',
    'closeTimeUtc',
  ];
  const changed: string[] = [];
  for (const field of fields) {
    if (prev[field] !== next[field]) {
      changed.push(field);
    }
  }
  return changed;
}

interface StoredInMemoryCandle {
  configIdentityHash: string;
  providerEnv: string | null;
  accountScopeHash: string | null;
  candle: NormalizedCandle;
}

interface StoredInMemoryRevision {
  configIdentityHash: string;
  event: CandleRevisionEvent;
}

/**
 * Deterministic in-memory candle store for unit tests and unconfigured zero-credential runs.
 * Reports HistoryPersistenceState = 'NOT_PERSISTENT' so UI never claims durable retention.
 */
export class InMemoryCandleStore implements CandleStore {
  private readonly records = new Map<string, StoredInMemoryCandle>();
  private readonly revisions: StoredInMemoryRevision[] = [];
  private readonly checkpoints = new Map<string, FeedCheckpointRecord>();

  getPersistenceState(): HistoryPersistenceState {
    return 'NOT_PERSISTENT';
  }

  async ensureReady(): Promise<HistoryPersistenceState> {
    return 'NOT_PERSISTENT';
  }

  getLastPersistenceError(): string | null {
    return null;
  }

  async upsertCandles(
    candles: readonly NormalizedCandle[],
    detectedAtUtc: string = new Date().toISOString(),
    scope?: CandleStorageScope
  ): Promise<CandleUpsertSummary> {
    let inserted = 0;
    let unchanged = 0;
    const revisionsDetected: CandleRevisionEvent[] = [];

    const configIdentityHash =
      scope?.configIdentityHash?.trim() || LEGACY_UNSCOPED_CONFIG_IDENTITY;
    const providerEnv = scope?.providerEnv ?? null;
    const accountScopeHash = scope?.accountScopeHash ?? null;

    for (const candle of candles) {
      if (!candle.complete) {
        continue;
      }

      const storageKey = scope?.configIdentityHash
        ? buildScopedCandleStorageKey(configIdentityHash, candle)
        : buildDeterministicCandleKey({
            provider: candle.provider,
            providerSymbol: candle.providerSymbol,
            priceBasis: candle.priceBasis,
            granularity: candle.granularity,
            openTimeUtc: candle.openTimeUtc,
          });
      const scopedCandle: NormalizedCandle = {
        ...candle,
        sourceCandleId: storageKey,
      };

      const existing = this.records.get(storageKey);
      if (!existing) {
        this.records.set(storageKey, {
          configIdentityHash,
          providerEnv,
          accountScopeHash,
          candle: scopedCandle,
        });
        inserted += 1;
        continue;
      }

      const changedFields = diffCandleFields(existing.candle, scopedCandle);
      if (changedFields.length === 0) {
        unchanged += 1;
        continue;
      }

      const revision: CandleRevisionEvent = {
        sourceCandleId: storageKey,
        detectedAtUtc,
        changedFields,
        previousClose: existing.candle.close,
        revisedClose: scopedCandle.close,
      };
      this.revisions.push({ configIdentityHash, event: revision });
      revisionsDetected.push(revision);
      this.records.set(storageKey, {
        configIdentityHash,
        providerEnv,
        accountScopeHash,
        candle: scopedCandle,
      });
    }

    return { inserted, unchanged, revisionsDetected };
  }

  async getCompletedCandles(
    options: CandleQueryOptions
  ): Promise<NormalizedCandle[]> {
    const filtered = Array.from(this.records.values())
      .filter((entry) => {
        const c = entry.candle;
        if (!c.complete) return false;
        if (c.granularity !== options.granularity) return false;
        if (
          options.configIdentityHash &&
          entry.configIdentityHash !== options.configIdentityHash
        ) {
          return false;
        }
        if (options.provider && c.provider !== options.provider) {
          return false;
        }
        if (
          options.providerEnv !== undefined &&
          options.providerEnv !== null &&
          entry.providerEnv !== options.providerEnv
        ) {
          return false;
        }
        if (
          options.accountScopeHash !== undefined &&
          options.accountScopeHash !== null &&
          entry.accountScopeHash !== options.accountScopeHash
        ) {
          return false;
        }
        if (
          options.providerSymbol &&
          c.providerSymbol !== options.providerSymbol
        ) {
          return false;
        }
        if (options.priceBasis && c.priceBasis !== options.priceBasis) {
          return false;
        }
        return true;
      })
      .map((entry) => entry.candle)
      .sort((a, b) => Date.parse(a.openTimeUtc) - Date.parse(b.openTimeUtc));

    const boundedLimit = Math.max(1, Math.min(options.limit, 500));
    return filtered.slice(-boundedLimit);
  }

  async getLatestCompletedCandle(
    granularity: MarketGranularity,
    scope?: Omit<CandleQueryOptions, 'granularity' | 'limit'>
  ): Promise<NormalizedCandle | null> {
    const rows = await this.getCompletedCandles({
      ...scope,
      granularity,
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async getRevisionEvents(
    configIdentityHash?: string
  ): Promise<CandleRevisionEvent[]> {
    if (!configIdentityHash) {
      return this.revisions.map((r) => r.event);
    }
    return this.revisions
      .filter((r) => r.configIdentityHash === configIdentityHash)
      .map((r) => r.event);
  }

  async saveFeedCheckpoint(checkpoint: FeedCheckpointRecord): Promise<void> {
    this.checkpoints.set(checkpoint.checkpointKey, {
      ...checkpoint,
      providerEnv: checkpoint.providerEnv ?? null,
      accountScopeHash: checkpoint.accountScopeHash ?? null,
      warnings: [...checkpoint.warnings],
    });
  }

  async getFeedCheckpoint(
    checkpointKey: string = DEFAULT_FEED_CHECKPOINT_KEY
  ): Promise<FeedCheckpointRecord | null> {
    const cp = this.checkpoints.get(checkpointKey);
    return cp ? { ...cp, warnings: [...cp.warnings] } : null;
  }

  async close(): Promise<void> {
    // No external connections to tear down
  }
}

/**
 * Minimal parameterized PostgreSQL query executor interface (compatible with `pg` Pool/Client).
 */
export interface PgQueryExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

/**
 * Persistent PostgreSQL candle store behind explicit DATABASE_URL configuration.
 * - Uses strictly parameterized SQL queries ($1..$N) to eliminate SQL injection vectors.
 * - Automatically creates a bounded `pg.Pool` when DATABASE_URL is configured and no custom executor is injected.
 * - Runs idempotent versioned migrations via `ensureReady()` and fails closed to `POSTGRES_CONFIGURED`
 *   if connectivity or migration fails (never crashing status endpoints or leaking credentials).
 */
export class PostgresCandleStore implements CandleStore {
  private readonly databaseUrl: string | null;
  private readonly executor: PgQueryExecutor | null;
  private readonly managedExecutor: ManagedPgExecutor | null;
  private readonly connectionConfigured: boolean;
  private readonly autoMigrate: boolean;
  private readonly revisions: CandleRevisionEvent[] = [];

  private verifiedConnected: boolean;
  private migrationsApplied = false;
  private initPromise: Promise<HistoryPersistenceState> | null = null;
  private lastError: string | null = null;

  static readonly SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS normalized_candles (
      source_candle_id TEXT PRIMARY KEY,
      config_identity_hash TEXT NOT NULL DEFAULT 'legacy_unscoped',
      provider TEXT NOT NULL,
      provider_env TEXT NULL,
      account_scope_hash TEXT NULL,
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
      source_retrieved_at_utc TIMESTAMPTZ NOT NULL
    );
  `;

  constructor(options: {
    databaseUrl?: string | null;
    executor?: PgQueryExecutor | null;
    autoMigrate?: boolean;
    env?: Record<string, string | undefined>;
  }) {
    const trimmedUrl = options.databaseUrl?.trim() ?? '';
    this.databaseUrl = trimmedUrl.length > 0 ? trimmedUrl : null;
    this.connectionConfigured = this.databaseUrl !== null;
    this.autoMigrate = options.autoMigrate ?? true;

    if (options.executor) {
      this.executor = options.executor;
      this.managedExecutor = null;
      this.verifiedConnected = this.connectionConfigured;
    } else if (
      this.databaseUrl &&
      isValidPostgresConnectionString(this.databaseUrl)
    ) {
      try {
        const managed = createManagedPgExecutor(
          this.databaseUrl,
          options.env ?? process.env
        );
        this.managedExecutor = managed;
        this.executor = managed;
        this.verifiedConnected = false;
      } catch (err) {
        this.managedExecutor = null;
        this.executor = null;
        this.verifiedConnected = false;
        this.lastError = redactSensitiveText(
          err instanceof Error
            ? err.message
            : 'Invalid PostgreSQL configuration',
          [this.databaseUrl]
        );
      }
    } else {
      this.managedExecutor = null;
      this.executor = null;
      this.verifiedConnected = false;
      if (this.databaseUrl) {
        this.lastError = 'Invalid DATABASE_URL format; expected postgres:// or postgresql://';
      }
    }
  }

  getPersistenceState(): HistoryPersistenceState {
    if (!this.connectionConfigured) {
      return 'NOT_PERSISTENT';
    }
    return this.executor && this.verifiedConnected
      ? 'POSTGRES_CONNECTED'
      : 'POSTGRES_CONFIGURED';
  }

  getLastPersistenceError(): string | null {
    return this.lastError;
  }

  /**
   * Verifies PostgreSQL connectivity and applies idempotent Stage 2A migrations once per store lifecycle.
   * If connectivity fails, transitions safely to POSTGRES_CONFIGURED without throwing or leaking secrets.
   */
  async ensureReady(): Promise<HistoryPersistenceState> {
    if (!this.connectionConfigured) {
      return 'NOT_PERSISTENT';
    }
    if (!this.executor) {
      return 'POSTGRES_CONFIGURED';
    }
    if (this.verifiedConnected && (!this.autoMigrate || this.migrationsApplied)) {
      return 'POSTGRES_CONNECTED';
    }

    if (!this.initPromise) {
      this.initPromise = this.initializeConnection().finally(() => {
        this.initPromise = null;
      });
    }

    return this.initPromise;
  }

  private async initializeConnection(): Promise<HistoryPersistenceState> {
    if (!this.executor) return 'POSTGRES_CONFIGURED';

    try {
      if (this.managedExecutor) {
        const reachable = await this.managedExecutor.ping();
        if (!reachable) {
          this.verifiedConnected = false;
          this.lastError = 'PostgreSQL connection health check failed';
          return 'POSTGRES_CONFIGURED';
        }
      }

      if (this.autoMigrate && !this.migrationsApplied) {
        await runPostgresMigrations(this.executor);
        this.migrationsApplied = true;
      }

      this.verifiedConnected = true;
      this.lastError = null;
      return 'POSTGRES_CONNECTED';
    } catch (err) {
      this.verifiedConnected = false;
      const rawMsg =
        err instanceof Error ? err.message : 'PostgreSQL initialization failed';
      this.lastError = redactSensitiveText(
        rawMsg,
        this.databaseUrl ? [this.databaseUrl] : []
      );
      return 'POSTGRES_CONFIGURED';
    }
  }

  async upsertCandles(
    candles: readonly NormalizedCandle[],
    detectedAtUtc: string = new Date().toISOString(),
    scope?: CandleStorageScope
  ): Promise<CandleUpsertSummary> {
    if (!this.executor) {
      return { inserted: 0, unchanged: 0, revisionsDetected: [] };
    }
    if (!this.verifiedConnected) {
      const state = await this.ensureReady();
      if (state !== 'POSTGRES_CONNECTED') {
        return { inserted: 0, unchanged: 0, revisionsDetected: [] };
      }
    }

    let inserted = 0;
    let unchanged = 0;
    const revisionsDetected: CandleRevisionEvent[] = [];

    const configIdentityHash =
      scope?.configIdentityHash?.trim() || LEGACY_UNSCOPED_CONFIG_IDENTITY;
    const providerEnv = scope?.providerEnv ?? null;
    const accountScopeHash = scope?.accountScopeHash ?? null;

    for (const c of candles) {
      if (!c.complete) continue;

      const scopedCandleId = scope?.configIdentityHash
        ? buildScopedCandleStorageKey(configIdentityHash, c)
        : c.sourceCandleId;

      const existingRes = await this.executor.query<{
        open_price: string;
        high_price: string;
        low_price: string;
        close_price: string;
        volume: number | null;
        close_time_utc: string;
      }>(
        `SELECT open_price, high_price, low_price, close_price, volume, close_time_utc
         FROM normalized_candles
         WHERE source_candle_id = $1`,
        [scopedCandleId]
      );

      const existing = existingRes.rows[0];
      if (existing) {
        const changedFields: string[] = [];
        if (String(existing.open_price) !== c.open) changedFields.push('open');
        if (String(existing.high_price) !== c.high) changedFields.push('high');
        if (String(existing.low_price) !== c.low) changedFields.push('low');
        if (String(existing.close_price) !== c.close)
          changedFields.push('close');
        if (existing.volume !== c.volume) changedFields.push('volume');

        if (changedFields.length === 0) {
          unchanged += 1;
          continue;
        }

        const rev: CandleRevisionEvent = {
          sourceCandleId: scopedCandleId,
          detectedAtUtc,
          changedFields,
          previousClose: String(existing.close_price),
          revisedClose: c.close,
        };
        this.revisions.push(rev);
        revisionsDetected.push(rev);

        await this.executor.query(
          `INSERT INTO candle_revision_events (
            source_candle_id, detected_at_utc, changed_fields, previous_close, revised_close, config_identity_hash
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            rev.sourceCandleId,
            rev.detectedAtUtc,
            rev.changedFields,
            rev.previousClose,
            rev.revisedClose,
            configIdentityHash,
          ]
        );
      } else {
        inserted += 1;
      }

      await this.executor.query(
        `INSERT INTO normalized_candles (
          source_candle_id, provider, provider_symbol, granularity, price_basis,
          open_time_utc, close_time_utc, open_price, high_price, low_price, close_price,
          volume, complete, source_retrieved_at_utc,
          config_identity_hash, provider_env, account_scope_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (source_candle_id) DO UPDATE SET
          open_price = EXCLUDED.open_price,
          high_price = EXCLUDED.high_price,
          low_price = EXCLUDED.low_price,
          close_price = EXCLUDED.close_price,
          volume = EXCLUDED.volume,
          source_retrieved_at_utc = EXCLUDED.source_retrieved_at_utc,
          config_identity_hash = EXCLUDED.config_identity_hash,
          provider_env = EXCLUDED.provider_env,
          account_scope_hash = EXCLUDED.account_scope_hash`,
        [
          scopedCandleId,
          c.provider,
          c.providerSymbol,
          c.granularity,
          c.priceBasis,
          c.openTimeUtc,
          c.closeTimeUtc,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          c.complete,
          c.sourceRetrievedAtUtc,
          configIdentityHash,
          providerEnv,
          accountScopeHash,
        ]
      );
    }

    return { inserted, unchanged, revisionsDetected };
  }

  async getCompletedCandles(
    options: CandleQueryOptions
  ): Promise<NormalizedCandle[]> {
    if (!this.executor) return [];
    if (!this.verifiedConnected) {
      const state = await this.ensureReady();
      if (state !== 'POSTGRES_CONNECTED') return [];
    }

    const boundedLimit = Math.max(1, Math.min(options.limit, 500));
    const params: unknown[] = [options.granularity, boundedLimit];
    let sql = `SELECT source_candle_id, provider, provider_symbol, granularity, price_basis,
        open_time_utc, close_time_utc, open_price, high_price, low_price, close_price,
        volume, complete, source_retrieved_at_utc
      FROM normalized_candles
      WHERE complete = TRUE AND granularity = $1`;

    if (options.configIdentityHash) {
      params.push(options.configIdentityHash);
      sql += ` AND config_identity_hash = $${params.length}`;
    }

    if (options.provider) {
      params.push(options.provider);
      sql += ` AND provider = $${params.length}`;
    }

    if (options.providerEnv !== undefined && options.providerEnv !== null) {
      params.push(options.providerEnv);
      sql += ` AND provider_env = $${params.length}`;
    }

    if (
      options.accountScopeHash !== undefined &&
      options.accountScopeHash !== null
    ) {
      params.push(options.accountScopeHash);
      sql += ` AND account_scope_hash = $${params.length}`;
    }

    if (options.providerSymbol) {
      params.push(options.providerSymbol);
      sql += ` AND provider_symbol = $${params.length}`;
    }

    if (options.priceBasis) {
      params.push(options.priceBasis);
      sql += ` AND price_basis = $${params.length}`;
    }

    sql += ` ORDER BY open_time_utc DESC LIMIT $2`;

    const res = await this.executor.query<{
      source_candle_id: string;
      provider: string;
      provider_symbol: string;
      granularity: MarketGranularity;
      price_basis: 'MID' | 'BID' | 'ASK';
      open_time_utc: string | Date;
      close_time_utc: string | Date;
      open_price: string;
      high_price: string;
      low_price: string;
      close_price: string;
      volume: number | null;
      complete: boolean;
      source_retrieved_at_utc: string | Date;
    }>(sql, params);

    return res.rows
      .map((r) => ({
        provider: r.provider,
        providerSymbol: r.provider_symbol,
        granularity: r.granularity,
        priceBasis: r.price_basis,
        openTimeUtc: new Date(r.open_time_utc).toISOString(),
        closeTimeUtc: new Date(r.close_time_utc).toISOString(),
        open: String(r.open_price),
        high: String(r.high_price),
        low: String(r.low_price),
        close: String(r.close_price),
        volume: r.volume,
        complete: r.complete,
        sourceRetrievedAtUtc: new Date(r.source_retrieved_at_utc).toISOString(),
        sourceCandleId: r.source_candle_id,
      }))
      .reverse();
  }

  async getLatestCompletedCandle(
    granularity: MarketGranularity,
    scope?: Omit<CandleQueryOptions, 'granularity' | 'limit'>
  ): Promise<NormalizedCandle | null> {
    const rows = await this.getCompletedCandles({
      ...scope,
      granularity,
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async getRevisionEvents(
    configIdentityHash?: string
  ): Promise<CandleRevisionEvent[]> {
    if (!this.executor) return [...this.revisions];
    if (!this.verifiedConnected) {
      const state = await this.ensureReady();
      if (state !== 'POSTGRES_CONNECTED') return [...this.revisions];
    }

    try {
      const params: unknown[] = [];
      let sql = `SELECT source_candle_id, detected_at_utc, changed_fields, previous_close, revised_close
         FROM candle_revision_events`;
      if (configIdentityHash) {
        params.push(configIdentityHash);
        sql += ` WHERE config_identity_hash = $1`;
      }
      sql += ` ORDER BY detected_at_utc ASC`;

      const res = await this.executor.query<{
        source_candle_id: string;
        detected_at_utc: string | Date;
        changed_fields: string[];
        previous_close: string;
        revised_close: string;
      }>(sql, params);

      return res.rows.map((row) => ({
        sourceCandleId: row.source_candle_id,
        detectedAtUtc: new Date(row.detected_at_utc).toISOString(),
        changedFields: Array.isArray(row.changed_fields)
          ? row.changed_fields
          : [],
        previousClose: String(row.previous_close),
        revisedClose: String(row.revised_close),
      }));
    } catch {
      return [...this.revisions];
    }
  }

  async saveFeedCheckpoint(checkpoint: FeedCheckpointRecord): Promise<void> {
    if (!this.executor) return;
    if (!this.verifiedConnected) {
      const state = await this.ensureReady();
      if (state !== 'POSTGRES_CONNECTED') return;
    }

    await this.executor.query(
      `INSERT INTO market_feed_checkpoints (
        checkpoint_key, config_identity_hash, provider, price_basis, policy_version,
        adapter_name, provider_symbol, state, provider_verified,
        last_successful_request_utc, last_provider_candle_open_utc, last_complete_candle_close_utc,
        missing_bar_count, duplicate_bar_count, reason_code, warnings, updated_at_utc,
        provider_env, account_scope_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (checkpoint_key) DO UPDATE SET
        config_identity_hash = EXCLUDED.config_identity_hash,
        provider = EXCLUDED.provider,
        price_basis = EXCLUDED.price_basis,
        policy_version = EXCLUDED.policy_version,
        adapter_name = EXCLUDED.adapter_name,
        provider_symbol = EXCLUDED.provider_symbol,
        state = EXCLUDED.state,
        provider_verified = EXCLUDED.provider_verified,
        last_successful_request_utc = EXCLUDED.last_successful_request_utc,
        last_provider_candle_open_utc = EXCLUDED.last_provider_candle_open_utc,
        last_complete_candle_close_utc = EXCLUDED.last_complete_candle_close_utc,
        missing_bar_count = EXCLUDED.missing_bar_count,
        duplicate_bar_count = EXCLUDED.duplicate_bar_count,
        reason_code = EXCLUDED.reason_code,
        warnings = EXCLUDED.warnings,
        updated_at_utc = EXCLUDED.updated_at_utc,
        provider_env = EXCLUDED.provider_env,
        account_scope_hash = EXCLUDED.account_scope_hash`,
      [
        checkpoint.checkpointKey,
        checkpoint.configIdentityHash,
        checkpoint.provider,
        checkpoint.priceBasis,
        checkpoint.policyVersion,
        checkpoint.adapterName,
        checkpoint.providerSymbol,
        checkpoint.state,
        checkpoint.providerVerified,
        checkpoint.lastSuccessfulRequestUtc,
        checkpoint.lastProviderCandleOpenUtc,
        checkpoint.lastCompleteCandleCloseUtc,
        checkpoint.missingBarCount,
        checkpoint.duplicateBarCount,
        checkpoint.reasonCode,
        checkpoint.warnings,
        checkpoint.updatedAtUtc,
        checkpoint.providerEnv ?? null,
        checkpoint.accountScopeHash ?? null,
      ]
    );
  }

  async getFeedCheckpoint(
    checkpointKey: string = DEFAULT_FEED_CHECKPOINT_KEY
  ): Promise<FeedCheckpointRecord | null> {
    if (!this.executor) return null;
    if (!this.verifiedConnected) {
      const state = await this.ensureReady();
      if (state !== 'POSTGRES_CONNECTED') return null;
    }

    const res = await this.executor.query<{
      checkpoint_key: string;
      config_identity_hash: string | null;
      provider: string | null;
      provider_env: string | null;
      account_scope_hash: string | null;
      price_basis: PriceBasis | null;
      policy_version: string | null;
      adapter_name: string;
      provider_symbol: string | null;
      state: MarketDataProviderState;
      provider_verified: boolean;
      last_successful_request_utc: string | Date | null;
      last_provider_candle_open_utc: string | Date | null;
      last_complete_candle_close_utc: string | Date | null;
      missing_bar_count: number | null;
      duplicate_bar_count: number | null;
      reason_code: string | null;
      warnings: string[] | null;
      updated_at_utc: string | Date;
    }>(
      `SELECT checkpoint_key, config_identity_hash, provider, provider_env, account_scope_hash,
              price_basis, policy_version, adapter_name, provider_symbol, state, provider_verified,
              last_successful_request_utc, last_provider_candle_open_utc, last_complete_candle_close_utc,
              missing_bar_count, duplicate_bar_count, reason_code, warnings, updated_at_utc
       FROM market_feed_checkpoints
       WHERE checkpoint_key = $1`,
      [checkpointKey]
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      checkpointKey: row.checkpoint_key,
      configIdentityHash: row.config_identity_hash ?? null,
      provider: row.provider ?? null,
      providerEnv: row.provider_env ?? null,
      accountScopeHash: row.account_scope_hash ?? null,
      priceBasis: row.price_basis ?? null,
      policyVersion: row.policy_version ?? null,
      adapterName: row.adapter_name,
      providerSymbol: row.provider_symbol,
      state: row.state,
      providerVerified: row.provider_verified,
      lastSuccessfulRequestUtc: row.last_successful_request_utc
        ? new Date(row.last_successful_request_utc).toISOString()
        : null,
      lastProviderCandleOpenUtc: row.last_provider_candle_open_utc
        ? new Date(row.last_provider_candle_open_utc).toISOString()
        : null,
      lastCompleteCandleCloseUtc: row.last_complete_candle_close_utc
        ? new Date(row.last_complete_candle_close_utc).toISOString()
        : null,
      missingBarCount: row.missing_bar_count,
      duplicateBarCount: row.duplicate_bar_count,
      reasonCode: row.reason_code,
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      updatedAtUtc: new Date(row.updated_at_utc).toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.managedExecutor) {
      await this.managedExecutor.close();
      this.verifiedConnected = false;
    }
  }
}
