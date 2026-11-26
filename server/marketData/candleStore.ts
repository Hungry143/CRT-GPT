import type {
  CandleRevisionEvent,
  HistoryPersistenceState,
  MarketGranularity,
  NormalizedCandle,
} from '@/shared/contracts/marketData';
import { buildDeterministicCandleKey } from '@/shared/utils/candleValidator';

export interface CandleUpsertSummary {
  inserted: number;
  unchanged: number;
  revisionsDetected: CandleRevisionEvent[];
}

export interface CandleQueryOptions {
  providerSymbol?: string;
  granularity: MarketGranularity;
  limit: number;
}

/**
 * Provider-neutral completed-candle repository contract.
 * Never persists production history to Next.js ephemeral container filesystem or browser localStorage.
 */
export interface CandleStore {
  getPersistenceState(): HistoryPersistenceState;
  upsertCandles(
    candles: readonly NormalizedCandle[],
    detectedAtUtc?: string
  ): Promise<CandleUpsertSummary>;
  getCompletedCandles(options: CandleQueryOptions): Promise<NormalizedCandle[]>;
  getLatestCompletedCandle(
    granularity: MarketGranularity
  ): Promise<NormalizedCandle | null>;
  getRevisionEvents(): Promise<CandleRevisionEvent[]>;
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

/**
 * Deterministic in-memory candle store for unit tests and unconfigured zero-credential runs.
 * Reports HistoryPersistenceState = 'NOT_PERSISTENT' so UI never claims durable retention.
 */
export class InMemoryCandleStore implements CandleStore {
  private readonly records = new Map<string, NormalizedCandle>();
  private readonly revisions: CandleRevisionEvent[] = [];

  getPersistenceState(): HistoryPersistenceState {
    return 'NOT_PERSISTENT';
  }

  async upsertCandles(
    candles: readonly NormalizedCandle[],
    detectedAtUtc: string = new Date().toISOString()
  ): Promise<CandleUpsertSummary> {
    let inserted = 0;
    let unchanged = 0;
    const revisionsDetected: CandleRevisionEvent[] = [];

    for (const candle of candles) {
      if (!candle.complete) {
        continue;
      }

      const key = buildDeterministicCandleKey({
        provider: candle.provider,
        providerSymbol: candle.providerSymbol,
        priceBasis: candle.priceBasis,
        granularity: candle.granularity,
        openTimeUtc: candle.openTimeUtc,
      });

      const existing = this.records.get(key);
      if (!existing) {
        this.records.set(key, candle);
        inserted += 1;
        continue;
      }

      const changedFields = diffCandleFields(existing, candle);
      if (changedFields.length === 0) {
        unchanged += 1;
        continue;
      }

      const revision: CandleRevisionEvent = {
        sourceCandleId: key,
        detectedAtUtc,
        changedFields,
        previousClose: existing.close,
        revisedClose: candle.close,
      };
      this.revisions.push(revision);
      revisionsDetected.push(revision);
      this.records.set(key, candle);
    }

    return { inserted, unchanged, revisionsDetected };
  }

  async getCompletedCandles(
    options: CandleQueryOptions
  ): Promise<NormalizedCandle[]> {
    const filtered = Array.from(this.records.values())
      .filter((c) => {
        if (!c.complete) return false;
        if (c.granularity !== options.granularity) return false;
        if (
          options.providerSymbol &&
          c.providerSymbol !== options.providerSymbol
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => Date.parse(a.openTimeUtc) - Date.parse(b.openTimeUtc));

    const boundedLimit = Math.max(1, Math.min(options.limit, 500));
    return filtered.slice(-boundedLimit);
  }

  async getLatestCompletedCandle(
    granularity: MarketGranularity
  ): Promise<NormalizedCandle | null> {
    const rows = await this.getCompletedCandles({ granularity, limit: 1 });
    return rows[0] ?? null;
  }

  async getRevisionEvents(): Promise<CandleRevisionEvent[]> {
    return [...this.revisions];
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
 * Optional persistent PostgreSQL candle store behind explicit DATABASE_URL configuration.
 * Uses strictly parameterized SQL queries ($1..$N) to eliminate SQL injection vectors.
 */
export class PostgresCandleStore implements CandleStore {
  private readonly executor: PgQueryExecutor | null;
  private readonly connectionConfigured: boolean;
  private readonly revisions: CandleRevisionEvent[] = [];

  static readonly SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS normalized_candles (
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
      source_retrieved_at_utc TIMESTAMPTZ NOT NULL
    );
  `;

  constructor(options: {
    databaseUrl?: string | null;
    executor?: PgQueryExecutor | null;
  }) {
    this.connectionConfigured = Boolean(
      options.databaseUrl && options.databaseUrl.trim().length > 0
    );
    this.executor = options.executor ?? null;
  }

  getPersistenceState(): HistoryPersistenceState {
    if (!this.connectionConfigured) {
      return 'NOT_PERSISTENT';
    }
    return this.executor ? 'POSTGRES_CONNECTED' : 'POSTGRES_CONFIGURED';
  }

  async upsertCandles(
    candles: readonly NormalizedCandle[],
    detectedAtUtc: string = new Date().toISOString()
  ): Promise<CandleUpsertSummary> {
    if (!this.executor) {
      return { inserted: 0, unchanged: 0, revisionsDetected: [] };
    }

    let inserted = 0;
    let unchanged = 0;
    const revisionsDetected: CandleRevisionEvent[] = [];

    for (const c of candles) {
      if (!c.complete) continue;

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
        [c.sourceCandleId]
      );

      const existing = existingRes.rows[0];
      if (existing) {
        const changedFields: string[] = [];
        if (existing.open_price !== c.open) changedFields.push('open');
        if (existing.high_price !== c.high) changedFields.push('high');
        if (existing.low_price !== c.low) changedFields.push('low');
        if (existing.close_price !== c.close) changedFields.push('close');
        if (existing.volume !== c.volume) changedFields.push('volume');

        if (changedFields.length === 0) {
          unchanged += 1;
          continue;
        }

        const rev: CandleRevisionEvent = {
          sourceCandleId: c.sourceCandleId,
          detectedAtUtc,
          changedFields,
          previousClose: existing.close_price,
          revisedClose: c.close,
        };
        this.revisions.push(rev);
        revisionsDetected.push(rev);
      } else {
        inserted += 1;
      }

      await this.executor.query(
        `INSERT INTO normalized_candles (
          source_candle_id, provider, provider_symbol, granularity, price_basis,
          open_time_utc, close_time_utc, open_price, high_price, low_price, close_price,
          volume, complete, source_retrieved_at_utc
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (source_candle_id) DO UPDATE SET
          open_price = EXCLUDED.open_price,
          high_price = EXCLUDED.high_price,
          low_price = EXCLUDED.low_price,
          close_price = EXCLUDED.close_price,
          volume = EXCLUDED.volume,
          source_retrieved_at_utc = EXCLUDED.source_retrieved_at_utc`,
        [
          c.sourceCandleId,
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
        ]
      );
    }

    return { inserted, unchanged, revisionsDetected };
  }

  async getCompletedCandles(
    options: CandleQueryOptions
  ): Promise<NormalizedCandle[]> {
    if (!this.executor) return [];

    const boundedLimit = Math.max(1, Math.min(options.limit, 500));
    const params: unknown[] = [options.granularity, boundedLimit];
    let sql = `SELECT source_candle_id, provider, provider_symbol, granularity, price_basis,
        open_time_utc, close_time_utc, open_price, high_price, low_price, close_price,
        volume, complete, source_retrieved_at_utc
      FROM normalized_candles
      WHERE complete = TRUE AND granularity = $1`;

    if (options.providerSymbol) {
      sql += ` AND provider_symbol = $3`;
      params.push(options.providerSymbol);
    }

    sql += ` ORDER BY open_time_utc DESC LIMIT $2`;

    const res = await this.executor.query<{
      source_candle_id: string;
      provider: string;
      provider_symbol: string;
      granularity: MarketGranularity;
      price_basis: 'MID' | 'BID' | 'ASK';
      open_time_utc: string;
      close_time_utc: string;
      open_price: string;
      high_price: string;
      low_price: string;
      close_price: string;
      volume: number | null;
      complete: boolean;
      source_retrieved_at_utc: string;
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
    granularity: MarketGranularity
  ): Promise<NormalizedCandle | null> {
    const rows = await this.getCompletedCandles({ granularity, limit: 1 });
    return rows[0] ?? null;
  }

  async getRevisionEvents(): Promise<CandleRevisionEvent[]> {
    return [...this.revisions];
  }
}
