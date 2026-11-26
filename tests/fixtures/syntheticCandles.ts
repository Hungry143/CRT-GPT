/**
 * DEVELOPMENT & TEST FIXTURES ONLY — NEVER IMPORT IN PRODUCTION API ROUTES OR LIVE UI.
 * Watermark: SYNTHETIC TEST DATA — NOT LIVE / NO SIGNAL
 */

import type {
  MarketGranularity,
  NormalizedCandle,
  PriceBasis,
} from '@/shared/contracts/marketData';
import { buildDeterministicCandleKey } from '@/shared/utils/candleValidator';
import {
  computeCandleCloseTimeUtc,
  computeNextBoundaryUtc,
  DEFAULT_ALIGNMENT_POLICY,
} from '@/shared/utils/sessionClock';

export const SYNTHETIC_FIXTURE_WATERMARK =
  'SYNTHETIC TEST DATA — NOT LIVE / NO SIGNAL' as const;

export interface SyntheticSeriesOptions {
  startOpenTimeUtc: string;
  count: number;
  granularity: MarketGranularity;
  provider?: string;
  providerSymbol?: string;
  priceBasis?: PriceBasis;
  retrievedAtUtc?: string;
}

/**
 * Generates deterministic synthetic completed candles strictly for unit/contract testing.
 */
export function buildSyntheticClosedCandles(
  options: SyntheticSeriesOptions
): NormalizedCandle[] {
  const provider = options.provider ?? 'synthetic_test_fixture';
  const providerSymbol = options.providerSymbol ?? 'XAU_USD';
  const priceBasis = options.priceBasis ?? 'MID';
  const retrievedAtUtc =
    options.retrievedAtUtc ?? '2026-06-15T12:00:00.000Z';

  const candles: NormalizedCandle[] = [];
  let cursor = new Date(options.startOpenTimeUtc);

  for (let i = 0; i < options.count; i++) {
    const openTimeUtc = cursor.toISOString();
    const closeTimeUtc = computeCandleCloseTimeUtc(
      openTimeUtc,
      options.granularity,
      DEFAULT_ALIGNMENT_POLICY
    );
    const base = 2600 + i * 2;
    const open = (base + 0.5).toFixed(3);
    const high = (base + 4.25).toFixed(3);
    const low = (base - 2.75).toFixed(3);
    const close = (base + 1.75).toFixed(3);

    candles.push({
      provider,
      providerSymbol,
      granularity: options.granularity,
      priceBasis,
      openTimeUtc,
      closeTimeUtc,
      open,
      high,
      low,
      close,
      volume: 100 + i * 5,
      complete: true,
      sourceRetrievedAtUtc: retrievedAtUtc,
      sourceCandleId: buildDeterministicCandleKey({
        provider,
        providerSymbol,
        priceBasis,
        granularity: options.granularity,
        openTimeUtc,
      }),
    });

    cursor = computeNextBoundaryUtc(
      cursor,
      options.granularity,
      DEFAULT_ALIGNMENT_POLICY
    );
  }

  return candles;
}

/**
 * Builds a raw OANDA v20-shaped synthetic JSON payload for adapter normalization tests.
 */
export function buildSyntheticOandaRawPayload(
  candles: readonly NormalizedCandle[],
  granularity = 'M15'
) {
  return {
    instrument: candles[0]?.providerSymbol ?? 'XAU_USD',
    granularity,
    candles: candles.map((c) => ({
      complete: c.complete,
      volume: c.volume ?? 0,
      time: c.openTimeUtc,
      mid: {
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
      },
    })),
  };
}
