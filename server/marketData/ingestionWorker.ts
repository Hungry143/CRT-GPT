import type {
  CandleRevisionEvent,
  MarketDataProviderState,
  MarketGranularity,
} from '@/shared/contracts/marketData';
import type { MarketDataAdapter } from '@/server/marketData/adapter';
import {
  BackfillService,
  type BackfillRunResult,
} from '@/server/marketData/backfillService';
import {
  DEFAULT_FEED_CHECKPOINT_KEY,
  type CandleStore,
  type FeedCheckpointRecord,
} from '@/server/marketData/candleStore';
import {
  buildFeedConfigIdentity,
  type FeedConfigIdentity,
} from '@/server/marketData/feedCheckpoint';
import { OANDA_MAX_CANDLES_PER_REQUEST } from '@/server/marketData/oandaV20Adapter';
import {
  DEFAULT_STALENESS_THRESHOLDS_SECONDS,
  evaluateFeedStatusFreshness,
} from '@/shared/utils/feedIntegrity';
import type { VerifiedMarketSchedule } from '@/shared/utils/sessionClock';

export const WORKER_DEFAULT_GRANULARITIES: readonly MarketGranularity[] = [
  'D1',
  'H4',
  'H1',
  'M15',
] as const;

export const WORKER_MIN_POLL_INTERVAL_MS = 5_000;
export const WORKER_MAX_PAGES_CAP = 100;
export const WORKER_MAX_CYCLE_DURATION_MS = 120_000;

export interface IngestionWorkerConfig {
  /**
   * Both flags MUST be explicitly true for live ingestion to execute.
   * Both default strictly to false.
   */
  marketFeedEnabled?: boolean;
  backfillEnabled?: boolean;
  granularities?: readonly MarketGranularity[];
  pollIntervalMs?: number;
  batchSize?: number;
  maxPagesPerGranularity?: number;
  maxCycleDurationMs?: number;
  maxConsecutiveFailures?: number;
  lookbackHoursByGranularity?: Partial<Record<MarketGranularity, number>>;
  checkpointKey?: string;
  /**
   * Keeps the Node.js event loop alive while `running === true` so the standalone worker
   * process stays alive and periodically ingests data until `stop()` is invoked. Defaults to `true`.
   */
  keepProcessAlive?: boolean;
  /**
   * Internal testing hook only: allows sub-5s intervals in deterministic unit tests.
   */
  allowFastIntervalForTests?: boolean;
}

export interface GranularityCycleSummary {
  granularity: MarketGranularity;
  result: BackfillRunResult;
}

export interface IngestionCycleReport {
  status:
    | 'DISABLED'
    | 'COMPLETED'
    | 'DEGRADED'
    | 'SKIPPED_IN_FLIGHT'
    | 'CIRCUIT_OPEN'
    | 'ABORTED';
  startedAtUtc: string;
  finishedAtUtc: string;
  granularitiesProcessed: GranularityCycleSummary[];
  totalInserted: number;
  totalUnchanged: number;
  totalMissingBars: number;
  totalDuplicateBars: number;
  revisionsDetected: CandleRevisionEvent[];
  reasonCode: string | null;
}

export interface IngestionWorkerStats {
  running: boolean;
  inFlight: boolean;
  liveIngestionAllowed: boolean;
  cyclesAttempted: number;
  cyclesCompleted: number;
  cyclesSkippedOverlap: number;
  consecutiveFailures: number;
  circuitOpen: boolean;
  lastCycleReport: IngestionCycleReport | null;
}

const DEFAULT_LOOKBACK_HOURS: Record<MarketGranularity, number> = {
  D1: 24 * 30,
  H4: 24 * 7,
  H1: 24 * 3,
  M15: 24,
  M1: 6,
};

/**
 * Bounded, non-overlapping standalone market-data ingestion worker architecture.
 *
 * Safety & architectural invariants:
 * - Live ingestion is DISABLED by default (`marketFeedEnabled=false`, `backfillEnabled=false`).
 * - Never executes inside Next.js serverless API request handlers; run via `scripts/ingestion-worker.ts`
 *   or an external cron/process supervisor.
 * - Uses chained `setTimeout` scheduling (kept ref'd while running) + an in-flight lock so the
 *   worker stays alive periodically ingesting data with zero overlapping cycles.
 * - `stop()` clears pending timers, aborts in-flight requests, awaits active cycle drain, and
 *   resolves `waitUntilStopped()` cleanly before database pools are closed.
 * - Stamps canonical `FeedConfigIdentity` onto every durable checkpoint persisted into `CandleStore`.
 */
export class MarketDataIngestionWorker {
  readonly deploymentRequirement =
    'Run MarketDataIngestionWorker exclusively in a dedicated standalone Node worker process or cron scheduler (never inside Next.js API routes).';

  private readonly adapter: MarketDataAdapter;
  private readonly store: CandleStore;
  private readonly backfillService: BackfillService;
  private readonly configIdentity: FeedConfigIdentity;
  private readonly verifiedSchedule: VerifiedMarketSchedule | null;
  private readonly nowFn: () => Date;

  private readonly marketFeedEnabled: boolean;
  private readonly backfillEnabled: boolean;
  private readonly granularities: readonly MarketGranularity[];
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxPagesPerGranularity: number;
  private readonly maxCycleDurationMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly lookbackHours: Record<MarketGranularity, number>;
  private readonly checkpointKey: string;
  private readonly keepProcessAlive: boolean;

  private running = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private activeCyclePromise: Promise<IngestionCycleReport> | null = null;
  private stoppedPromise: Promise<void> | null = null;
  private resolveStopped: (() => void) | null = null;

  private cyclesAttempted = 0;
  private cyclesCompleted = 0;
  private cyclesSkippedOverlap = 0;
  private consecutiveFailures = 0;
  private lastCycleReport: IngestionCycleReport | null = null;

  constructor(options: {
    adapter: MarketDataAdapter;
    store: CandleStore;
    configIdentity?: FeedConfigIdentity;
    verifiedSchedule?: VerifiedMarketSchedule | null;
    config?: IngestionWorkerConfig;
    nowFn?: () => Date;
  }) {
    const cfg = options.config ?? {};
    this.adapter = options.adapter;
    this.store = options.store;
    this.verifiedSchedule = options.verifiedSchedule ?? null;
    this.nowFn = options.nowFn ?? (() => new Date());

    this.configIdentity =
      options.configIdentity ??
      buildFeedConfigIdentity({
        provider:
          options.adapter.adapterName === 'OandaV20MarketDataAdapter'
            ? 'oanda_v20'
            : options.adapter.adapterName,
        priceBasis: options.adapter.alignmentPolicy.priceBasis,
        policyVersion: options.adapter.alignmentPolicy.policyVersion,
      });

    this.marketFeedEnabled = cfg.marketFeedEnabled === true;
    this.backfillEnabled = cfg.backfillEnabled === true;
    this.granularities =
      cfg.granularities && cfg.granularities.length > 0
        ? [...cfg.granularities]
        : WORKER_DEFAULT_GRANULARITIES;

    const minInterval = cfg.allowFastIntervalForTests
      ? 10
      : WORKER_MIN_POLL_INTERVAL_MS;
    this.pollIntervalMs = Math.max(minInterval, cfg.pollIntervalMs ?? 60_000);
    this.batchSize = Math.max(
      1,
      Math.min(cfg.batchSize ?? 500, OANDA_MAX_CANDLES_PER_REQUEST)
    );
    this.maxPagesPerGranularity = Math.max(
      1,
      Math.min(cfg.maxPagesPerGranularity ?? 10, WORKER_MAX_PAGES_CAP)
    );
    this.maxCycleDurationMs = Math.max(
      1_000,
      Math.min(cfg.maxCycleDurationMs ?? 30_000, WORKER_MAX_CYCLE_DURATION_MS)
    );
    this.maxConsecutiveFailures = Math.max(
      1,
      Math.min(cfg.maxConsecutiveFailures ?? 3, 20)
    );
    this.lookbackHours = {
      ...DEFAULT_LOOKBACK_HOURS,
      ...(cfg.lookbackHoursByGranularity ?? {}),
    };
    this.checkpointKey = cfg.checkpointKey ?? DEFAULT_FEED_CHECKPOINT_KEY;
    this.keepProcessAlive = cfg.keepProcessAlive ?? true;

    this.backfillService = new BackfillService({
      adapter: this.adapter,
      store: this.store,
      enabled: this.isLiveIngestionAllowed(),
      nowFn: this.nowFn,
    });
  }

  isLiveIngestionAllowed(): boolean {
    return (
      this.marketFeedEnabled &&
      this.backfillEnabled &&
      this.adapter.adapterName !== 'NoProviderAdapter'
    );
  }

  getStats(): IngestionWorkerStats {
    return {
      running: this.running,
      inFlight: this.inFlight,
      liveIngestionAllowed: this.isLiveIngestionAllowed(),
      cyclesAttempted: this.cyclesAttempted,
      cyclesCompleted: this.cyclesCompleted,
      cyclesSkippedOverlap: this.cyclesSkippedOverlap,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.consecutiveFailures >= this.maxConsecutiveFailures,
      lastCycleReport: this.lastCycleReport,
    };
  }

  /**
   * Executes one strictly bounded ingestion cycle across configured granularities.
   * Refuses to execute any network call when live ingestion is disabled.
   */
  async runCycleOnce(
    externalSignal?: AbortSignal
  ): Promise<IngestionCycleReport> {
    const startedAt = this.nowFn();
    const startedAtUtc = startedAt.toISOString();

    if (!this.isLiveIngestionAllowed()) {
      const report: IngestionCycleReport = {
        status: 'DISABLED',
        startedAtUtc,
        finishedAtUtc: this.nowFn().toISOString(),
        granularitiesProcessed: [],
        totalInserted: 0,
        totalUnchanged: 0,
        totalMissingBars: 0,
        totalDuplicateBars: 0,
        revisionsDetected: [],
        reasonCode: 'LIVE_INGESTION_DISABLED',
      };
      this.lastCycleReport = report;
      return report;
    }

    if (this.inFlight) {
      this.cyclesSkippedOverlap += 1;
      const report: IngestionCycleReport = {
        status: 'SKIPPED_IN_FLIGHT',
        startedAtUtc,
        finishedAtUtc: this.nowFn().toISOString(),
        granularitiesProcessed: [],
        totalInserted: 0,
        totalUnchanged: 0,
        totalMissingBars: 0,
        totalDuplicateBars: 0,
        revisionsDetected: [],
        reasonCode: 'PREVIOUS_CYCLE_IN_FLIGHT',
      };
      this.lastCycleReport = report;
      return report;
    }

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      const report: IngestionCycleReport = {
        status: 'CIRCUIT_OPEN',
        startedAtUtc,
        finishedAtUtc: this.nowFn().toISOString(),
        granularitiesProcessed: [],
        totalInserted: 0,
        totalUnchanged: 0,
        totalMissingBars: 0,
        totalDuplicateBars: 0,
        revisionsDetected: [],
        reasonCode: 'WORKER_CIRCUIT_BREAKER_OPEN',
      };
      this.lastCycleReport = report;
      return report;
    }

    this.inFlight = true;
    this.cyclesAttempted += 1;

    const cyclePromise = this.executeCycleInternal(startedAt, externalSignal);
    this.activeCyclePromise = cyclePromise;

    try {
      return await cyclePromise;
    } finally {
      if (this.activeCyclePromise === cyclePromise) {
        this.activeCyclePromise = null;
      }
      this.inFlight = false;
    }
  }

  private async executeCycleInternal(
    startedAt: Date,
    externalSignal?: AbortSignal
  ): Promise<IngestionCycleReport> {
    const startedAtUtc = startedAt.toISOString();
    const cycleController = new AbortController();
    const onAbort = () => cycleController.abort();

    if (externalSignal?.aborted || this.abortController?.signal.aborted) {
      cycleController.abort();
    } else {
      externalSignal?.addEventListener('abort', onAbort, { once: true });
      this.abortController?.signal.addEventListener('abort', onAbort, {
        once: true,
      });
    }

    const summaries: GranularityCycleSummary[] = [];
    let totalInserted = 0;
    let totalUnchanged = 0;
    let totalMissingBars = 0;
    let totalDuplicateBars = 0;
    const revisionsDetected: CandleRevisionEvent[] = [];
    let cycleFailed = false;
    let cycleAborted = false;
    let reasonCode: string | null = null;

    try {
      await this.store.ensureReady();

      for (const granularity of this.granularities) {
        if (cycleController.signal.aborted) {
          cycleAborted = true;
          reasonCode = 'WORKER_CYCLE_ABORTED';
          break;
        }

        const elapsedMs = this.nowFn().getTime() - startedAt.getTime();
        const remainingMs = this.maxCycleDurationMs - elapsedMs;
        if (remainingMs <= 0) {
          cycleAborted = true;
          reasonCode = 'MAX_CYCLE_DURATION_EXCEEDED';
          break;
        }

        const latestStoredRows = await this.store.getCompletedCandles({
          provider:
            this.configIdentity.provider !== 'none'
              ? this.configIdentity.provider
              : undefined,
          providerSymbol: this.configIdentity.providerSymbol ?? undefined,
          priceBasis: this.configIdentity.priceBasis,
          granularity,
          limit: 1,
        });
        const latestStored = latestStoredRows[0] ?? null;

        const now = this.nowFn();
        const defaultLookbackMs =
          this.lookbackHours[granularity] * 3_600_000;
        const fromUtc = latestStored
          ? latestStored.openTimeUtc
          : new Date(now.getTime() - defaultLookbackMs).toISOString();
        const toUtc = now.toISOString();

        const res = await this.backfillService.scheduleOnce({
          granularity,
          fromUtc,
          toUtc,
          batchSize: this.batchSize,
          maxPages: this.maxPagesPerGranularity,
          maxDurationMs: remainingMs,
          signal: cycleController.signal,
        });

        summaries.push({ granularity, result: res });
        totalInserted += res.insertedCount;
        totalUnchanged += res.unchangedCount;
        totalMissingBars += res.missingBarCount;
        totalDuplicateBars += res.duplicateBarCount;
        revisionsDetected.push(...res.revisionsDetected);

        if (res.status === 'ABORTED') {
          cycleAborted = true;
          reasonCode = res.reasonCode ?? 'WORKER_CYCLE_ABORTED';
          break;
        }
        if (res.status !== 'COMPLETED') {
          cycleFailed = true;
          reasonCode = res.reasonCode ?? 'INGESTION_GRANULARITY_FAILED';
        }
      }

      if (totalMissingBars > 0) {
        cycleFailed = true;
        reasonCode = reasonCode ?? 'UNEXPECTED_BAR_GAP';
      }
      if (totalDuplicateBars > 0) {
        cycleFailed = true;
        reasonCode = reasonCode ?? 'CANDLE_INTEGRITY_VIOLATION';
      }

      if (cycleFailed) {
        this.consecutiveFailures += 1;
      } else if (!cycleAborted) {
        this.consecutiveFailures = 0;
        this.cyclesCompleted += 1;
      }

      await this.persistFeedCheckpoint({
        totalMissingBars,
        totalDuplicateBars,
        cycleFailed,
        reasonCode,
      });

      const status: IngestionCycleReport['status'] = cycleAborted
        ? 'ABORTED'
        : cycleFailed
          ? 'DEGRADED'
          : 'COMPLETED';

      const report: IngestionCycleReport = {
        status,
        startedAtUtc,
        finishedAtUtc: this.nowFn().toISOString(),
        granularitiesProcessed: summaries,
        totalInserted,
        totalUnchanged,
        totalMissingBars,
        totalDuplicateBars,
        revisionsDetected,
        reasonCode,
      };
      this.lastCycleReport = report;
      return report;
    } finally {
      externalSignal?.removeEventListener('abort', onAbort);
      this.abortController?.signal.removeEventListener('abort', onAbort);
    }
  }

  private async persistFeedCheckpoint(summary: {
    totalMissingBars: number;
    totalDuplicateBars: number;
    cycleFailed: boolean;
    reasonCode: string | null;
  }): Promise<void> {
    const now = this.nowFn();
    const adapterStatus = await this.adapter.getStatus(now);
    const evaluated = evaluateFeedStatusFreshness({
      currentState: adapterStatus.quality.state,
      lastCompleteCandleCloseUtc:
        adapterStatus.quality.lastCompleteCandleCloseUtc,
      missingBarCount:
        summary.totalMissingBars > 0
          ? summary.totalMissingBars
          : adapterStatus.quality.missingBarCount,
      duplicateBarCount:
        summary.totalDuplicateBars > 0
          ? summary.totalDuplicateBars
          : adapterStatus.quality.duplicateBarCount,
      nowUtc: now,
      staleThresholdSeconds: DEFAULT_STALENESS_THRESHOLDS_SECONDS.M15,
      verifiedSchedule: this.verifiedSchedule,
      reasonCode: summary.reasonCode ?? adapterStatus.quality.reasonCode,
      warnings: adapterStatus.quality.warnings,
    });

    let finalState: MarketDataProviderState = evaluated.state;
    if (summary.cycleFailed && finalState === 'CONNECTED') {
      finalState = summary.totalDuplicateBars > 0 ? 'ERROR' : 'STALE';
    }

    const checkpoint: FeedCheckpointRecord = {
      checkpointKey: this.checkpointKey,
      configIdentityHash: this.configIdentity.configIdentityHash,
      provider: this.configIdentity.provider,
      priceBasis: this.configIdentity.priceBasis,
      policyVersion: this.configIdentity.policyVersion,
      adapterName: adapterStatus.adapterName,
      providerSymbol:
        adapterStatus.instrument?.providerSymbol ??
        this.configIdentity.providerSymbol,
      state: finalState,
      providerVerified: adapterStatus.providerVerified,
      lastSuccessfulRequestUtc: adapterStatus.quality.lastSuccessfulRequestUtc,
      lastProviderCandleOpenUtc:
        adapterStatus.quality.lastProviderCandleOpenUtc,
      lastCompleteCandleCloseUtc:
        adapterStatus.quality.lastCompleteCandleCloseUtc,
      missingBarCount:
        summary.totalMissingBars > 0
          ? summary.totalMissingBars
          : adapterStatus.quality.missingBarCount,
      duplicateBarCount:
        summary.totalDuplicateBars > 0
          ? summary.totalDuplicateBars
          : adapterStatus.quality.duplicateBarCount,
      reasonCode: evaluated.reasonCode ?? summary.reasonCode,
      warnings: evaluated.warnings,
      updatedAtUtc: now.toISOString(),
    };

    try {
      await this.store.saveFeedCheckpoint(checkpoint);
    } catch {
      // Never crash worker loop on transient checkpoint persistence errors
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;

      void this.runCycleOnce()
        .catch(() => {
          // Errors are captured inside cycle report; keep scheduling resilient
        })
        .finally(() => {
          if (this.running) {
            this.scheduleNextTick(this.pollIntervalMs);
          }
        });
    }, delayMs);

    if (!this.keepProcessAlive && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Starts the bounded, non-overlapping periodic worker loop using chained timeouts.
   * Keeps the standalone Node process alive while running (`keepProcessAlive: true`).
   * Refuses to start when live ingestion is disabled (default).
   */
  start(options: { runImmediately?: boolean } = {}): {
    started: boolean;
    reasonCode: string | null;
  } {
    if (!this.isLiveIngestionAllowed()) {
      return { started: false, reasonCode: 'LIVE_INGESTION_DISABLED' };
    }
    if (this.running) {
      return { started: true, reasonCode: null };
    }

    this.running = true;
    this.abortController = new AbortController();
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });

    const initialDelayMs = options.runImmediately ? 0 : this.pollIntervalMs;
    this.scheduleNextTick(initialDelayMs);

    return { started: true, reasonCode: null };
  }

  /**
   * Resolves once `stop()` has drained any active cycle and stopped the worker loop.
   */
  waitUntilStopped(): Promise<void> {
    return this.stoppedPromise ?? Promise.resolve();
  }

  /**
   * Gracefully stops the worker loop, aborts any in-flight cycle, and awaits active cycle drain
   * before resolving so database pools are never closed mid-query.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.activeCyclePromise) {
      try {
        await this.activeCyclePromise;
      } catch {
        // Ignore cycle errors during graceful shutdown
      }
    }
    if (this.resolveStopped) {
      const done = this.resolveStopped;
      this.resolveStopped = null;
      this.stoppedPromise = null;
      done();
    }
  }
}
