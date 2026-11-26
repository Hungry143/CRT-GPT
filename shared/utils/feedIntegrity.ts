import type {
  AlignmentPolicy,
  MarketDataProviderState,
  MarketGranularity,
  NormalizedCandle,
} from '@/shared/contracts/marketData';
import type {
  CandleSeriesValidationResult,
  CandleValidationIssue,
} from '@/shared/utils/candleValidator';
import {
  DEFAULT_ALIGNMENT_POLICY,
  type VerifiedMarketSchedule,
} from '@/shared/utils/sessionClock';

/**
 * Granularity-aware staleness budgets (in seconds) when the market is NOT confirmed closed
 * by a verified FX/metals schedule.
 * Age strictly greater than the threshold triggers fail-closed STALE state.
 */
export const DEFAULT_STALENESS_THRESHOLDS_SECONDS: Readonly<
  Record<MarketGranularity, number>
> = {
  M1: 180, // 3 minutes
  M15: 1800, // 30 minutes (2 M15 bars)
  H1: 5400, // 90 minutes
  H4: 18_000, // 5 hours
  D1: 108_000, // 30 hours
};

/**
 * Default feed-level staleness threshold when evaluating adapter status without a specific granularity.
 */
export const DEFAULT_FEED_STALENESS_SECONDS = 1800;

const STRUCTURAL_VIOLATION_CODES = new Set<CandleValidationIssue['code']>([
  'SCHEMA_INVALID',
  'NON_POSITIVE_PRICE',
  'OHLC_INVARIANT_VIOLATION',
  'INVALID_TIMESTAMP_ORDER',
  'INTERVAL_DURATION_MISMATCH',
  'LOOKAHEAD_TIMESTAMP',
  'DUPLICATE_BAR',
  'REVERSED_SERIES_ORDER',
]);

export interface SeriesIntegrityOptions {
  granularity: MarketGranularity;
  nowUtc: Date;
  policy?: AlignmentPolicy;
  staleThresholdSeconds?: number;
  verifiedSchedule?: VerifiedMarketSchedule | null;
  /**
   * When true (default for completed-bar reads), incomplete/premature bars in a stored series
   * also trigger fail-closed rejection. During raw provider normalization, trailing incomplete bars
   * may be stripped without tainting prior finalized bars.
   */
  failOnIncompleteBars?: boolean;
}

export interface SeriesIntegrityVerdict {
  healthy: boolean;
  failClosed: boolean;
  state: MarketDataProviderState;
  reasonCode: string | null;
  freshnessSeconds: number | null;
  warnings: string[];
}

export function isConfirmedClosedAt(
  instantUtc: Date,
  verifiedSchedule?: VerifiedMarketSchedule | null
): boolean {
  if (!verifiedSchedule) return false;
  const cls = verifiedSchedule.classifyInstant(instantUtc);
  return cls === 'WEEKEND_CLOSED' || cls === 'HOLIDAY_CLOSED';
}

export function computeFreshnessSeconds(
  lastCompleteCandleCloseUtc: string | null,
  nowUtc: Date
): number | null {
  if (!lastCompleteCandleCloseUtc) return null;
  const closeMs = Date.parse(lastCompleteCandleCloseUtc);
  if (Number.isNaN(closeMs)) return null;
  return Math.max(0, Math.floor((nowUtc.getTime() - closeMs) / 1000));
}

/**
 * Evaluates whether a validated candle series is safe to serve or must FAIL CLOSED.
 *
 * Fail-closed rules:
 * 1. Structural integrity errors (OHLC violation, non-positive price, duplicate bar,
 *    reversed order, interval mismatch, lookahead) -> ERROR (CANDLE_INTEGRITY_VIOLATION)
 * 2. Unexpected missing bars (not excused by a verified market closure schedule) ->
 *    STALE (UNEXPECTED_BAR_GAP)
 * 3. Latest completed candle age exceeds granularity staleness threshold while market is
 *    not confirmed closed -> STALE (FEED_DATA_STALE)
 */
export function evaluateSeriesIntegrity(
  validation: CandleSeriesValidationResult,
  options: SeriesIntegrityOptions
): SeriesIntegrityVerdict {
  const threshold =
    options.staleThresholdSeconds ??
    DEFAULT_STALENESS_THRESHOLDS_SECONDS[options.granularity];
  const failOnIncomplete = options.failOnIncompleteBars ?? true;
  const warnings = [...validation.warnings];

  const hasStructuralViolation = validation.issues.some((issue) => {
    if (STRUCTURAL_VIOLATION_CODES.has(issue.code)) return true;
    if (
      failOnIncomplete &&
      (issue.code === 'INCOMPLETE_CANDLE' ||
        issue.code === 'PREMATURE_PUBLICATION')
    ) {
      return true;
    }
    return false;
  });

  if (hasStructuralViolation || validation.duplicateBarCount > 0) {
    warnings.push(
      'Fail-closed triggered: candle series failed structural or uniqueness validation.'
    );
    return {
      healthy: false,
      failClosed: true,
      state: 'ERROR',
      reasonCode: 'CANDLE_INTEGRITY_VIOLATION',
      freshnessSeconds: computeFreshnessSeconds(
        validation.accepted.at(-1)?.closeTimeUtc ?? null,
        options.nowUtc
      ),
      warnings,
    };
  }

  if (validation.missingBarCount > 0) {
    warnings.push(
      `Fail-closed triggered: ${validation.missingBarCount} unexpected missing ${options.granularity} bar(s) detected.`
    );
    return {
      healthy: false,
      failClosed: true,
      state: 'STALE',
      reasonCode: 'UNEXPECTED_BAR_GAP',
      freshnessSeconds: computeFreshnessSeconds(
        validation.accepted.at(-1)?.closeTimeUtc ?? null,
        options.nowUtc
      ),
      warnings,
    };
  }

  const latest: NormalizedCandle | null = validation.accepted.at(-1) ?? null;
  if (!latest) {
    warnings.push(
      `No completed ${options.granularity} candles are synchronized yet; feed cannot be reported as connected.`
    );
    return {
      healthy: false,
      failClosed: true,
      state: 'CONNECTING',
      reasonCode: 'AWAITING_COMPLETED_CANDLES',
      freshnessSeconds: null,
      warnings,
    };
  }

  const freshnessSeconds = computeFreshnessSeconds(
    latest.closeTimeUtc,
    options.nowUtc
  );

  if (
    latest &&
    freshnessSeconds !== null &&
    freshnessSeconds > threshold &&
    !isConfirmedClosedAt(options.nowUtc, options.verifiedSchedule)
  ) {
    warnings.push(
      `Fail-closed triggered: latest completed ${options.granularity} candle is stale (${freshnessSeconds}s > ${threshold}s threshold).`
    );
    return {
      healthy: false,
      failClosed: true,
      state: 'STALE',
      reasonCode: 'FEED_DATA_STALE',
      freshnessSeconds,
      warnings,
    };
  }

  if (isConfirmedClosedAt(options.nowUtc, options.verifiedSchedule)) {
    return {
      healthy: true,
      failClosed: false,
      state: 'MARKET_CLOSED',
      reasonCode: 'VERIFIED_MARKET_CLOSED',
      freshnessSeconds,
      warnings,
    };
  }

  return {
    healthy: true,
    failClosed: false,
    state: 'CONNECTED',
    reasonCode: null,
    freshnessSeconds,
    warnings,
  };
}

/**
 * Evaluates feed-level freshness for status endpoints so a previously CONNECTED adapter
 * fails closed to STALE if time advances past the staleness threshold without new completed bars.
 */
export function evaluateFeedStatusFreshness(params: {
  currentState: MarketDataProviderState;
  lastCompleteCandleCloseUtc: string | null;
  missingBarCount: number | null;
  duplicateBarCount: number | null;
  nowUtc: Date;
  staleThresholdSeconds?: number;
  verifiedSchedule?: VerifiedMarketSchedule | null;
  reasonCode: string | null;
  warnings: readonly string[];
}): {
  state: MarketDataProviderState;
  freshnessSeconds: number | null;
  reasonCode: string | null;
  warnings: string[];
} {
  const threshold =
    params.staleThresholdSeconds ?? DEFAULT_FEED_STALENESS_SECONDS;
  const freshnessSeconds = computeFreshnessSeconds(
    params.lastCompleteCandleCloseUtc,
    params.nowUtc
  );
  const warnings = [...params.warnings];

  if (
    (params.currentState === 'CONNECTED' ||
      params.currentState === 'MARKET_CLOSED') &&
    freshnessSeconds === null
  ) {
    const awaitWarn =
      'Provider verified without any synchronized completed candles; feed is awaiting completed bars.';
    if (!warnings.includes(awaitWarn)) {
      warnings.push(awaitWarn);
    }
    return {
      state: 'CONNECTING',
      freshnessSeconds: null,
      reasonCode: 'AWAITING_COMPLETED_CANDLES',
      warnings,
    };
  }

  if (params.currentState !== 'CONNECTED') {
    return {
      state: params.currentState,
      freshnessSeconds,
      reasonCode: params.reasonCode,
      warnings,
    };
  }

  if (params.duplicateBarCount !== null && params.duplicateBarCount > 0) {
    warnings.push(
      `Fail-closed: ${params.duplicateBarCount} duplicate bar(s) recorded on feed.`
    );
    return {
      state: 'ERROR',
      freshnessSeconds,
      reasonCode: 'CANDLE_INTEGRITY_VIOLATION',
      warnings,
    };
  }

  if (params.missingBarCount !== null && params.missingBarCount > 0) {
    warnings.push(
      `Fail-closed: ${params.missingBarCount} missing bar(s) detected on feed.`
    );
    return {
      state: 'STALE',
      freshnessSeconds,
      reasonCode: 'UNEXPECTED_BAR_GAP',
      warnings,
    };
  }

  if (
    freshnessSeconds !== null &&
    freshnessSeconds > threshold &&
    !isConfirmedClosedAt(params.nowUtc, params.verifiedSchedule)
  ) {
    warnings.push(
      `Fail-closed: latest completed candle age (${freshnessSeconds}s) exceeds staleness threshold (${threshold}s).`
    );
    return {
      state: 'STALE',
      freshnessSeconds,
      reasonCode: 'FEED_DATA_STALE',
      warnings,
    };
  }

  if (
    freshnessSeconds !== null &&
    isConfirmedClosedAt(params.nowUtc, params.verifiedSchedule)
  ) {
    return {
      state: 'MARKET_CLOSED',
      freshnessSeconds,
      reasonCode: 'VERIFIED_MARKET_CLOSED',
      warnings,
    };
  }

  return {
    state: params.currentState,
    freshnessSeconds,
    reasonCode: params.reasonCode,
    warnings,
  };
}

export function getDefaultPolicy(): AlignmentPolicy {
  return DEFAULT_ALIGNMENT_POLICY;
}
