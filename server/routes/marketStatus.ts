import { STAGE_2A_INVARIANTS } from '@/server/config/featureGates';
import {
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '@/server/marketData/registry';
import {
  MarketStatusResponseSchema,
  type MarketStatusResponse,
} from '@/shared/contracts/marketData';
import { toUtcIsoString } from '@/shared/utils/time';

export async function buildMarketStatusPayload(
  now: Date = new Date(),
  runtime: MarketDataRuntime = resolveMarketDataRuntime()
): Promise<MarketStatusResponse> {
  const status = await runtime.adapter.getStatus(now);

  return MarketStatusResponseSchema.parse({
    schemaVersion: '1.0.0',
    serverTimeUtc: toUtcIsoString(now),
    adapterName: status.adapterName,
    providerVerified: status.providerVerified,
    instrument: status.instrument,
    quality: status.quality,
    historyPersistence: runtime.historyPersistence,
    backfillEnabled: runtime.backfillEnabled,
    crtEngineEnabled: STAGE_2A_INVARIANTS.crtEngineEnabled,
    signalsEnabled: STAGE_2A_INVARIANTS.signalsEnabled,
    orderExecutionEnabled: STAGE_2A_INVARIANTS.orderExecutionEnabled,
  });
}
