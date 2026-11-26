import {
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '@/server/marketData/registry';
import { buildMarketStatusPayload } from '@/server/routes/marketStatus';
import {
  MarketSessionResponseSchema,
  type MarketSessionResponse,
  type ObservedMarketAvailability,
} from '@/shared/contracts/marketData';
import { buildSessionClockSnapshot } from '@/shared/utils/sessionClock';
import { toUtcIsoString } from '@/shared/utils/time';

export async function buildMarketSessionPayload(
  now: Date = new Date(),
  runtime: MarketDataRuntime = resolveMarketDataRuntime()
): Promise<MarketSessionResponse> {
  const status = await buildMarketStatusPayload(now, runtime);

  let observedMarketAvailability: ObservedMarketAvailability =
    'UNOBSERVED_NO_FEED';
  if (status.quality.state === 'CONNECTED') {
    observedMarketAvailability = 'OBSERVED_ACTIVE';
  } else if (status.quality.state === 'STALE') {
    observedMarketAvailability = 'OBSERVED_STALE';
  } else if (status.quality.state === 'MARKET_CLOSED') {
    observedMarketAvailability = 'OBSERVED_CLOSED';
  }

  const session = buildSessionClockSnapshot(now, {
    policy: runtime.adapter.alignmentPolicy,
    // No unverified holiday calendar assumed; remains UNKNOWN unless a verified schedule is injected.
    verifiedSchedule: null,
    observedMarketAvailability,
  });

  return MarketSessionResponseSchema.parse({
    schemaVersion: '1.0.0',
    serverTimeUtc: toUtcIsoString(now),
    session,
  });
}
