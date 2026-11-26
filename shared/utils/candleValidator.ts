import {
  NormalizedCandleSchema,
  type AlignmentPolicy,
  type MarketGranularity,
  type NormalizedCandle,
  type PriceBasis,
} from '@/shared/contracts/marketData';
import {
  computeCandleCloseTimeUtc,
  computeNextBoundaryUtc,
  DEFAULT_ALIGNMENT_POLICY,
  type VerifiedMarketSchedule,
} from '@/shared/utils/sessionClock';

export interface CandleValidationIssue {
  code:
    | 'SCHEMA_INVALID'
    | 'NON_POSITIVE_PRICE'
    | 'OHLC_INVARIANT_VIOLATION'
    | 'INVALID_TIMESTAMP_ORDER'
    | 'INTERVAL_DURATION_MISMATCH'
    | 'INCOMPLETE_CANDLE'
    | 'PREMATURE_PUBLICATION'
    | 'LOOKAHEAD_TIMESTAMP'
    | 'DUPLICATE_BAR'
    | 'REVERSED_SERIES_ORDER'
    | 'UNEXPECTED_GAP';
  message: string;
  candleIndex?: number;
  sourceCandleId?: string;
}

export interface CandleValidationResult {
  valid: boolean;
  issues: CandleValidationIssue[];
}

export interface CandleSeriesValidationResult {
  valid: boolean;
  accepted: NormalizedCandle[];
  rejected: Array<{ candle: unknown; issues: CandleValidationIssue[] }>;
  duplicateBarCount: number;
  missingBarCount: number;
  expectedClosureGapCount: number;
  warnings: string[];
  issues: CandleValidationIssue[];
}

/**
 * Builds the deterministic bar identity key:
 * `(provider, providerSymbol, priceBasis, granularity, openTimeUtc)`.
 */
export function buildDeterministicCandleKey(parts: {
  provider: string;
  providerSymbol: string;
  priceBasis: PriceBasis;
  granularity: MarketGranularity;
  openTimeUtc: string;
}): string {
  return `${parts.provider}:${parts.providerSymbol}:${parts.priceBasis}:${parts.granularity}:${parts.openTimeUtc}`;
}

/**
 * Exact decimal comparison using BigInt scaling so OHLC comparisons never suffer float drift.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const [aInt = '0', aFrac = ''] = a.split('.');
  const [bInt = '0', bFrac = ''] = b.split('.');
  const scale = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt(aInt + aFrac.padEnd(scale, '0'));
  const bScaled = BigInt(bInt + bFrac.padEnd(scale, '0'));
  if (aScaled < bScaled) return -1;
  if (aScaled > bScaled) return 1;
  return 0;
}

export interface ValidateCandleOptions {
  nowUtc?: Date;
  policy?: AlignmentPolicy;
  requireComplete?: boolean;
  enforceGracePeriod?: boolean;
  enforceIntervalAlignment?: boolean;
}

/**
 * Validates a single normalized candle against strict OHLC, UTC timestamp,
 * DST-aware interval length, and completion/grace-period finality rules.
 */
export function validateNormalizedCandle(
  candidate: unknown,
  options: ValidateCandleOptions = {}
): CandleValidationResult {
  const policy = options.policy ?? DEFAULT_ALIGNMENT_POLICY;
  const nowUtc = options.nowUtc ?? new Date();
  const requireComplete = options.requireComplete ?? true;
  const enforceGracePeriod = options.enforceGracePeriod ?? true;
  const enforceIntervalAlignment = options.enforceIntervalAlignment ?? true;

  const parsed = NormalizedCandleSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((i) => ({
        code: 'SCHEMA_INVALID' as const,
        message: `${i.path.join('.') || 'candle'}: ${i.message}`,
      })),
    };
  }

  const c = parsed.data;
  const issues: CandleValidationIssue[] = [];

  // Positive prices (double-checked via exact scaled BigInt > 0)
  for (const field of ['open', 'high', 'low', 'close'] as const) {
    if (compareDecimalStrings(c[field], '0') <= 0) {
      issues.push({
        code: 'NON_POSITIVE_PRICE',
        message: `${field} must be strictly positive`,
        sourceCandleId: c.sourceCandleId,
      });
    }
  }

  // OHLC structural invariants: high >= max(open, close, low), low <= min(open, close, high)
  if (
    compareDecimalStrings(c.high, c.open) < 0 ||
    compareDecimalStrings(c.high, c.close) < 0 ||
    compareDecimalStrings(c.high, c.low) < 0
  ) {
    issues.push({
      code: 'OHLC_INVARIANT_VIOLATION',
      message: `high (${c.high}) must be >= open (${c.open}), close (${c.close}), and low (${c.low})`,
      sourceCandleId: c.sourceCandleId,
    });
  }

  if (
    compareDecimalStrings(c.low, c.open) > 0 ||
    compareDecimalStrings(c.low, c.close) > 0 ||
    compareDecimalStrings(c.low, c.high) > 0
  ) {
    issues.push({
      code: 'OHLC_INVARIANT_VIOLATION',
      message: `low (${c.low}) must be <= open (${c.open}), close (${c.close}), and high (${c.high})`,
      sourceCandleId: c.sourceCandleId,
    });
  }

  const openMs = Date.parse(c.openTimeUtc);
  const closeMs = Date.parse(c.closeTimeUtc);

  if (Number.isNaN(openMs) || Number.isNaN(closeMs) || closeMs <= openMs) {
    issues.push({
      code: 'INVALID_TIMESTAMP_ORDER',
      message: `closeTimeUtc (${c.closeTimeUtc}) must be strictly after openTimeUtc (${c.openTimeUtc})`,
      sourceCandleId: c.sourceCandleId,
    });
  } else if (enforceIntervalAlignment) {
    const expectedClose = computeCandleCloseTimeUtc(
      c.openTimeUtc,
      c.granularity,
      policy
    );
    if (Date.parse(expectedClose) !== closeMs) {
      issues.push({
        code: 'INTERVAL_DURATION_MISMATCH',
        message: `Expected closeTimeUtc ${expectedClose} for ${c.granularity} bar opened at ${c.openTimeUtc}, got ${c.closeTimeUtc}`,
        sourceCandleId: c.sourceCandleId,
      });
    }
  }

  if (requireComplete && !c.complete) {
    issues.push({
      code: 'INCOMPLETE_CANDLE',
      message: 'Incomplete candles must never be published as finalized bars',
      sourceCandleId: c.sourceCandleId,
    });
  }

  const nowMs = nowUtc.getTime();
  if (!Number.isNaN(openMs) && openMs > nowMs) {
    issues.push({
      code: 'LOOKAHEAD_TIMESTAMP',
      message: `openTimeUtc (${c.openTimeUtc}) is in the future relative to nowUtc (${nowUtc.toISOString()})`,
      sourceCandleId: c.sourceCandleId,
    });
  }

  if (
    enforceGracePeriod &&
    requireComplete &&
    !Number.isNaN(closeMs) &&
    nowMs < closeMs + policy.publicationGraceSeconds * 1000
  ) {
    issues.push({
      code: 'PREMATURE_PUBLICATION',
      message: `Candle close (${c.closeTimeUtc}) has not passed publication grace window (${policy.publicationGraceSeconds}s)`,
      sourceCandleId: c.sourceCandleId,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

export interface ValidateSeriesOptions extends ValidateCandleOptions {
  verifiedSchedule?: VerifiedMarketSchedule | null;
  maxGapInspectionSteps?: number;
}

/**
 * Validates an entire ordered series of normalized candles, enforcing:
 * - Individual OHLC & finality invariants
 * - Strictly ascending UTC timestamps (rejects reversed series)
 * - No duplicate (provider, symbol, priceBasis, granularity, openTimeUtc) keys
 * - Gap auditing with verified-schedule closure awareness
 */
export function validateCandleSeries(
  candidates: readonly unknown[],
  options: ValidateSeriesOptions = {}
): CandleSeriesValidationResult {
  const policy = options.policy ?? DEFAULT_ALIGNMENT_POLICY;
  const maxSteps = options.maxGapInspectionSteps ?? 2000;

  const accepted: NormalizedCandle[] = [];
  const rejected: Array<{ candle: unknown; issues: CandleValidationIssue[] }> =
    [];
  const allIssues: CandleValidationIssue[] = [];
  const warnings: string[] = [];
  const seenKeys = new Set<string>();

  let duplicateBarCount = 0;
  let missingBarCount = 0;
  let expectedClosureGapCount = 0;
  let previousAccepted: NormalizedCandle | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const single = validateNormalizedCandle(item, options);
    if (!single.valid) {
      const tagged = single.issues.map((iss) => ({ ...iss, candleIndex: i }));
      rejected.push({ candle: item, issues: tagged });
      allIssues.push(...tagged);
      continue;
    }

    const candle = item as NormalizedCandle;
    const dedupKey = buildDeterministicCandleKey({
      provider: candle.provider,
      providerSymbol: candle.providerSymbol,
      priceBasis: candle.priceBasis,
      granularity: candle.granularity,
      openTimeUtc: candle.openTimeUtc,
    });

    if (seenKeys.has(dedupKey)) {
      duplicateBarCount += 1;
      const dupIssue: CandleValidationIssue = {
        code: 'DUPLICATE_BAR',
        message: `Duplicate bar detected for key ${dedupKey}`,
        candleIndex: i,
        sourceCandleId: candle.sourceCandleId,
      };
      rejected.push({ candle, issues: [dupIssue] });
      allIssues.push(dupIssue);
      continue;
    }

    if (previousAccepted !== null) {
      const prevOpenMs = Date.parse(previousAccepted.openTimeUtc);
      const currOpenMs = Date.parse(candle.openTimeUtc);
      if (currOpenMs <= prevOpenMs) {
        const orderIssue: CandleValidationIssue = {
          code: 'REVERSED_SERIES_ORDER',
          message: `Series out of chronological order at index ${i}: ${candle.openTimeUtc} <= ${previousAccepted.openTimeUtc}`,
          candleIndex: i,
          sourceCandleId: candle.sourceCandleId,
        };
        rejected.push({ candle, issues: [orderIssue] });
        allIssues.push(orderIssue);
        continue;
      }

      // Check for missing bars between previousAccepted.closeTimeUtc and candle.openTimeUtc
      let cursor = new Date(previousAccepted.closeTimeUtc);
      let steps = 0;
      let unexpectedMissingInGap = 0;
      let expectedClosedInGap = 0;

      while (cursor.getTime() < currOpenMs && steps < maxSteps) {
        const scheduleState = options.verifiedSchedule
          ? options.verifiedSchedule.classifyInstant(cursor)
          : 'UNKNOWN';

        if (
          scheduleState === 'WEEKEND_CLOSED' ||
          scheduleState === 'HOLIDAY_CLOSED'
        ) {
          expectedClosedInGap += 1;
        } else {
          unexpectedMissingInGap += 1;
        }

        cursor = computeNextBoundaryUtc(cursor, candle.granularity, policy);
        steps += 1;
      }

      if (expectedClosedInGap > 0 && unexpectedMissingInGap === 0) {
        expectedClosureGapCount += expectedClosedInGap;
      } else if (unexpectedMissingInGap > 0) {
        missingBarCount += unexpectedMissingInGap;
        const gapMsg = `Detected ${unexpectedMissingInGap} missing ${candle.granularity} bar(s) between ${previousAccepted.closeTimeUtc} and ${candle.openTimeUtc}${options.verifiedSchedule ? '' : ' (no verified holiday/weekend schedule configured)'}`;
        warnings.push(gapMsg);
        allIssues.push({
          code: 'UNEXPECTED_GAP',
          message: gapMsg,
          candleIndex: i,
          sourceCandleId: candle.sourceCandleId,
        });
      }
    }

    seenKeys.add(dedupKey);
    accepted.push(candle);
    previousAccepted = candle;
  }

  return {
    valid: rejected.length === 0 && missingBarCount === 0,
    accepted,
    rejected,
    duplicateBarCount,
    missingBarCount,
    expectedClosureGapCount,
    warnings,
    issues: allIssues,
  };
}
