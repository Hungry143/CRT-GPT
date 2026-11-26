import { STAGE_2A_INVARIANTS } from '@/server/config/featureGates';
import { resolveEffectiveFeedStatus } from '@/server/marketData/feedCheckpoint';
import {
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '@/server/marketData/registry';
import {
  MarketStatusResponseSchema,
  type MarketStatusResponse,
} from '@/shared/contracts/marketData';
import type { VerifiedMarketSchedule } from '@/shared/utils/sessionClock';
import { toUtcIsoString } from '@/shared/utils/time';

export interface BuildMarketStatusOptions {
  verifiedSchedule?: VerifiedMarketSchedule | null;
  staleThresholdSeconds?: number;
}

export async function buildMarketStatusPayload(
  now: Date = new Date(),
  runtime: MarketDataRuntime = resolveMarketDataRuntime(),
  options: BuildMarketStatusOptions = {}
): Promise<MarketStatusResponse> {
  const effective = await resolveEffectiveFeedStatus(now, runtime, {
    verifiedSchedule: options.verifiedSchedule,
    staleThresholdSeconds: options.staleThresholdSeconds,
  });

  return MarketStatusResponseSchema.parse({
    schemaVersion: '1.0.0',
    serverTimeUtc: toUtcIsoString(now),
    adapterName: effective.adapterName,
    providerVerified: effective.providerVerified,
    instrument: effective.instrument,
    quality: effective.quality,
    historyPersistence: effective.historyPersistence,
    backfillEnabled: runtime.backfillEnabled,
    crtEngineEnabled: STAGE_2A_INVARIANTS.crtEngineEnabled,
    signalsEnabled: STAGE_2A_INVARIANTS.signalsEnabled,
    orderExecutionEnabled: STAGE_2A_INVARIANTS.orderExecutionEnabled,
  });
}
