import type {
  CandleRevisionEvent,
  MarketGranularity,
} from '@/shared/contracts/marketData';
import type { MarketDataAdapter } from '@/server/marketData/adapter';
import type {
  CandleStorageScope,
  CandleStore,
} from '@/server/marketData/candleStore';
import { OANDA_MAX_CANDLES_PER_REQUEST } from '@/server/marketData/oandaV20Adapter';

export interface BackfillJobSpec {
  granularity: MarketGranularity;
  fromUtc: string;
  toUtc: string;
  batchSize?: number;
  maxPages?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
}

export interface BackfillRunResult {
  status: 'DISABLED' | 'COMPLETED' | 'ABORTED' | 'FAILED';
  pagesFetched: number;
  insertedCount: number;
  unchangedCount: number;
  duplicateBarCount: number;
  missingBarCount: number;
  revisionsDetected: CandleRevisionEvent[];
  warnings: string[];
  reasonCode: string | null;
}

/**
 * Standalone worker/scheduler interface.
 * Deployment requirement: Long-running historical backfills and scheduled incremental
 * polling MUST run in a separate Node worker process or external cron scheduler—never
 * inside an always-running background loop spawned from a Next.js serverless API request.
 */
export interface BackfillScheduler {
  readonly deploymentRequirement: string;
  scheduleOnce(spec: BackfillJobSpec): Promise<BackfillRunResult>;
}

/**
 * Bounded, idempotent historical candle backfill service.
 * Disabled by default (`enabled: false`).
 * Pages through provider history in bounded batches (<= 5000 candles/request),
 * advancing `fromUtc` with `includeFirst: false` after the first page so cursor
 * boundaries never lose or duplicate candles.
 */
export class BackfillService implements BackfillScheduler {
  readonly deploymentRequirement =
    'Execute BackfillService from a dedicated standalone Node worker or scheduled cron job, never as an unbounded loop inside a Next.js serverless request handler.';

  private readonly adapter: MarketDataAdapter;
  private readonly store: CandleStore;
  private readonly storageScope?: CandleStorageScope;
  private readonly enabled: boolean;
  private readonly nowFn: () => Date;

  constructor(options: {
    adapter: MarketDataAdapter;
    store: CandleStore;
    storageScope?: CandleStorageScope;
    enabled?: boolean;
    nowFn?: () => Date;
  }) {
    this.adapter = options.adapter;
    this.store = options.store;
    this.storageScope = options.storageScope;
    this.enabled = options.enabled ?? false;
    this.nowFn = options.nowFn ?? (() => new Date());
  }

  async scheduleOnce(spec: BackfillJobSpec): Promise<BackfillRunResult> {
    if (!this.enabled) {
      return {
        status: 'DISABLED',
        pagesFetched: 0,
        insertedCount: 0,
        unchangedCount: 0,
        duplicateBarCount: 0,
        missingBarCount: 0,
        revisionsDetected: [],
        warnings: [],
        reasonCode: 'BACKFILL_DISABLED_BY_DEFAULT',
      };
    }

    const fromMs = Date.parse(spec.fromUtc);
    const toMs = Date.parse(spec.toUtc);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
      return {
        status: 'FAILED',
        pagesFetched: 0,
        insertedCount: 0,
        unchangedCount: 0,
        duplicateBarCount: 0,
        missingBarCount: 0,
        revisionsDetected: [],
        warnings: ['Invalid backfill range: fromUtc must be strictly before toUtc'],
        reasonCode: 'INVALID_BACKFILL_RANGE',
      };
    }

    const batchSize = Math.max(
      1,
      Math.min(spec.batchSize ?? 500, OANDA_MAX_CANDLES_PER_REQUEST)
    );
    const maxPages = Math.max(1, Math.min(spec.maxPages ?? 25, 100));
    const maxDurationMs = spec.maxDurationMs ?? 30_000;
    const startedAtMs = this.nowFn().getTime();

    let cursorUtc = new Date(fromMs).toISOString();
    let includeFirst = true;
    let pagesFetched = 0;
    let insertedCount = 0;
    let unchangedCount = 0;
    let duplicateBarCount = 0;
    let missingBarCount = 0;
    const revisionsDetected: CandleRevisionEvent[] = [];
    const warnings: string[] = [];

    while (pagesFetched < maxPages) {
      if (spec.signal?.aborted) {
        return {
          status: 'ABORTED',
          pagesFetched,
          insertedCount,
          unchangedCount,
          duplicateBarCount,
          missingBarCount,
          revisionsDetected,
          warnings,
          reasonCode: 'BACKFILL_CANCELLED',
        };
      }

      if (this.nowFn().getTime() - startedAtMs > maxDurationMs) {
        warnings.push('Backfill stopped after reaching maxDurationMs guard');
        return {
          status: 'ABORTED',
          pagesFetched,
          insertedCount,
          unchangedCount,
          duplicateBarCount,
          missingBarCount,
          revisionsDetected,
          warnings,
          reasonCode: 'MAX_REQUEST_AGE_EXCEEDED',
        };
      }

      const page = await this.adapter.fetchCompletedCandles({
        granularity: spec.granularity,
        limit: batchSize,
        fromUtc: cursorUtc,
        includeFirst,
        signal: spec.signal,
      });

      pagesFetched += 1;
      duplicateBarCount += page.duplicateBarCount;
      missingBarCount += page.missingBarCount;
      warnings.push(...page.warnings);

      if (page.status !== 'CONNECTED' && page.status !== 'MARKET_CLOSED') {
        const recoverableHistorical =
          page.status === 'STALE' &&
          page.reasonCode === 'UNEXPECTED_BAR_GAP' &&
          page.duplicateBarCount === 0 &&
          Array.isArray(page.validatedHistoricalCandles) &&
          page.validatedHistoricalCandles.length > 0
            ? page.validatedHistoricalCandles.filter(
                (c) => Date.parse(c.openTimeUtc) < toMs
              )
            : [];

        if (recoverableHistorical.length > 0) {
          const upsert = await this.store.upsertCandles(
            recoverableHistorical,
            this.nowFn().toISOString(),
            this.storageScope
          );
          insertedCount += upsert.inserted;
          unchangedCount += upsert.unchanged;
          revisionsDetected.push(...upsert.revisionsDetected);
        }

        return {
          status: 'FAILED',
          pagesFetched,
          insertedCount,
          unchangedCount,
          duplicateBarCount,
          missingBarCount,
          revisionsDetected,
          warnings,
          reasonCode: page.reasonCode ?? page.status,
        };
      }

      if (page.candles.length === 0) {
        break;
      }

      // Filter candles strictly inside [fromUtc, toUtc)
      const inRange = page.candles.filter(
        (c) => Date.parse(c.openTimeUtc) < toMs
      );

      if (inRange.length > 0) {
        const upsert = await this.store.upsertCandles(
          inRange,
          this.nowFn().toISOString(),
          this.storageScope
        );
        insertedCount += upsert.inserted;
        unchangedCount += upsert.unchanged;
        revisionsDetected.push(...upsert.revisionsDetected);
      }

      const lastBar = page.candles.at(-1)!;
      const lastOpenMs = Date.parse(lastBar.openTimeUtc);

      // Stop if we reached/passed toUtc, received a partial page, or cursor failed to advance
      if (
        lastOpenMs >= toMs ||
        page.candles.length < batchSize ||
        (!includeFirst && lastBar.openTimeUtc === cursorUtc)
      ) {
        break;
      }

      // Advance cursor to the last received bar's openTimeUtc and set includeFirst=false
      // so the boundary bar is neither duplicated nor skipped.
      cursorUtc = lastBar.openTimeUtc;
      includeFirst = false;
    }

    return {
      status: 'COMPLETED',
      pagesFetched,
      insertedCount,
      unchangedCount,
      duplicateBarCount,
      missingBarCount,
      revisionsDetected,
      warnings,
      reasonCode: null,
    };
  }
}
