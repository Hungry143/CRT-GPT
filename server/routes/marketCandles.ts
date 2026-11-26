import { z } from 'zod';
import { resolveEffectiveFeedStatus } from '@/server/marketData/feedCheckpoint';
import {
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '@/server/marketData/registry';
import {
  MarketCandlesResponseSchema,
  MarketGranularitySchema,
  type MarketCandlesResponse,
  type MarketGranularity,
} from '@/shared/contracts/marketData';
import { validateCandleSeries } from '@/shared/utils/candleValidator';
import { evaluateSeriesIntegrity } from '@/shared/utils/feedIntegrity';
import type { VerifiedMarketSchedule } from '@/shared/utils/sessionClock';
import { toUtcIsoString } from '@/shared/utils/time';

export const MARKET_CANDLES_MAX_LIMIT = 500;
export const MARKET_CANDLES_DEFAULT_LIMIT = 100;

const MarketCandlesQuerySchema = z.object({
  instrument: z.literal('XAUUSD'),
  granularity: MarketGranularitySchema,
  limit: z
    .number()
    .int()
    .min(1, 'limit must be >= 1')
    .max(
      MARKET_CANDLES_MAX_LIMIT,
      `limit must be <= ${MARKET_CANDLES_MAX_LIMIT}`
    ),
});

export interface MarketCandlesQueryParseResult {
  ok: true;
  instrument: 'XAUUSD';
  granularity: MarketGranularity;
  limit: number;
}

export interface MarketCandlesQueryError {
  ok: false;
  httpStatus: 400;
  code: 'INVALID_QUERY_PARAMETER';
  error: string;
}

export function parseMarketCandlesQuery(
  searchParams: URLSearchParams
): MarketCandlesQueryParseResult | MarketCandlesQueryError {
  const rawInstrument = searchParams.get('instrument');
  const rawGranularity = searchParams.get('granularity');
  const rawLimit = searchParams.get('limit');

  if (!rawInstrument) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_QUERY_PARAMETER',
      error: 'instrument query parameter is required and must be XAUUSD',
    };
  }

  if (!rawGranularity) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_QUERY_PARAMETER',
      error:
        'granularity query parameter is required (allowed: D1, H4, H1, M15, M1)',
    };
  }

  let limit = MARKET_CANDLES_DEFAULT_LIMIT;
  if (rawLimit !== null && rawLimit.trim() !== '') {
    if (!/^\d+$/.test(rawLimit.trim())) {
      return {
        ok: false,
        httpStatus: 400,
        code: 'INVALID_QUERY_PARAMETER',
        error: `limit must be an integer between 1 and ${MARKET_CANDLES_MAX_LIMIT}`,
      };
    }
    limit = Number(rawLimit.trim());
  }

  const parsed = MarketCandlesQuerySchema.safeParse({
    instrument: rawInstrument.trim().toUpperCase(),
    granularity: rawGranularity.trim().toUpperCase(),
    limit,
  });

  if (!parsed.success) {
    return {
      ok: false,
      httpStatus: 400,
      code: 'INVALID_QUERY_PARAMETER',
      error: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
    };
  }

  return {
    ok: true,
    instrument: parsed.data.instrument,
    granularity: parsed.data.granularity,
    limit: parsed.data.limit,
  };
}

export interface BuildMarketCandlesOptions {
  verifiedSchedule?: VerifiedMarketSchedule | null;
  staleThresholdSeconds?: number;
}

export async function buildMarketCandlesPayload(
  params: {
    instrument: 'XAUUSD';
    granularity: MarketGranularity;
    limit: number;
  },
  now: Date = new Date(),
  runtime: MarketDataRuntime = resolveMarketDataRuntime(),
  options: BuildMarketCandlesOptions = {}
): Promise<MarketCandlesResponse> {
  const schedule = options.verifiedSchedule ?? runtime.closurePolicy ?? null;
  const effective = await resolveEffectiveFeedStatus(now, runtime, {
    verifiedSchedule: schedule,
    staleThresholdSeconds: options.staleThresholdSeconds,
  });
  const effectiveState = effective.quality.state;

  // Fail closed whenever effective feed status (adapter + identity-validated durable checkpoint)
  // is not in a healthy serveable state
  if (effectiveState !== 'CONNECTED' && effectiveState !== 'MARKET_CLOSED') {
    return MarketCandlesResponseSchema.parse({
      schemaVersion: '1.0.0',
      serverTimeUtc: toUtcIsoString(now),
      instrument: params.instrument,
      granularity: params.granularity,
      status: effectiveState,
      completedOnly: true,
      data: [],
      count: 0,
      limit: params.limit,
      reasonCode:
        effective.quality.reasonCode ??
        (effectiveState === 'NOT_CONFIGURED'
          ? 'NO_PROVIDER_CONFIGURED'
          : 'FEED_NOT_HEALTHY'),
    });
  }

  // Scope reads strictly to active feed configuration identity (provider, environment, division,
  // account scope hash, symbol, price basis, and alignment policy) so candles never leak across
  // accounts or environments sharing a database.
  const storedCandles = await runtime.store.getCompletedCandles({
    configIdentityHash: effective.activeConfigIdentityHash,
    provider:
      effective.activeProvider && effective.activeProvider !== 'none'
        ? effective.activeProvider
        : undefined,
    providerEnv: effective.activeProviderEnv,
    accountScopeHash: effective.activeAccountScopeHash,
    providerSymbol: effective.activeProviderSymbol ?? undefined,
    priceBasis: effective.activePriceBasis,
    granularity: params.granularity,
    limit: params.limit,
  });

  const validated = validateCandleSeries(storedCandles, {
    nowUtc: now,
    policy: runtime.adapter.alignmentPolicy,
    requireComplete: true,
    enforceGracePeriod: true,
    enforceIntervalAlignment: true,
    verifiedSchedule: schedule,
  });

  const integrity = evaluateSeriesIntegrity(validated, {
    granularity: params.granularity,
    nowUtc: now,
    policy: runtime.adapter.alignmentPolicy,
    staleThresholdSeconds:
      options.staleThresholdSeconds ?? runtime.staleThresholdSeconds,
    verifiedSchedule: schedule,
    failOnIncompleteBars: true,
  });

  // Strict fail-closed policy: never serve stale, gapped, duplicate, or corrupted candle series
  if (!integrity.healthy) {
    return MarketCandlesResponseSchema.parse({
      schemaVersion: '1.0.0',
      serverTimeUtc: toUtcIsoString(now),
      instrument: params.instrument,
      granularity: params.granularity,
      status: integrity.state,
      completedOnly: true,
      data: [],
      count: 0,
      limit: params.limit,
      reasonCode: integrity.reasonCode,
    });
  }

  return MarketCandlesResponseSchema.parse({
    schemaVersion: '1.0.0',
    serverTimeUtc: toUtcIsoString(now),
    instrument: params.instrument,
    granularity: params.granularity,
    status:
      effectiveState === 'MARKET_CLOSED' ? 'MARKET_CLOSED' : integrity.state,
    completedOnly: true,
    data: validated.accepted,
    count: validated.accepted.length,
    limit: params.limit,
    reasonCode: effective.quality.reasonCode ?? integrity.reasonCode,
  });
}
