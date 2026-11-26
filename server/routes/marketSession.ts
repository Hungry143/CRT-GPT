import { resolveEffectiveFeedStatus } from '@/server/marketData/feedCheckpoint';
import {
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '@/server/marketData/registry';
import {
  MarketSessionResponseSchema,
  type MarketSessionResponse,
  type ObservedMarketAvailability,
} from '@/shared/contracts/marketData';
import {
  buildSessionClockSnapshot,
  type VerifiedMarketSchedule,
} from '@/shared/utils/sessionClock';
import { toUtcIsoString } from '@/shared/utils/time';

export interface BuildMarketSessionOptions {
  verifiedSchedule?: VerifiedMarketSchedule | null;
}

export async function buildMarketSessionPayload(
  now: Date = new Date(),
  runtime: MarketDataRuntime = resolveMarketDataRuntime(),
  options: BuildMarketSessionOptions = {}
): Promise<MarketSessionResponse> {
  const schedule = options.verifiedSchedule ?? runtime.closurePolicy ?? null;
  const effective = await resolveEffectiveFeedStatus(now, runtime, {
    verifiedSchedule: schedule,
  });

  let observedMarketAvailability: ObservedMarketAvailability =
    'UNOBSERVED_NO_FEED';
  if (effective.quality.state === 'CONNECTED') {
    observedMarketAvailability = 'OBSERVED_ACTIVE';
  } else if (effective.quality.state === 'STALE') {
    observedMarketAvailability = 'OBSERVED_STALE';
  } else if (effective.quality.state === 'MARKET_CLOSED') {
    observedMarketAvailability = 'OBSERVED_CLOSED';
  }

  const session = buildSessionClockSnapshot(now, {
    policy: runtime.adapter.alignmentPolicy,
    verifiedSchedule: schedule,
    observedMarketAvailability,
  });

  return MarketSessionResponseSchema.parse({
    schemaVersion: '1.0.0',
    serverTimeUtc: toUtcIsoString(now),
    session,
  });
}
