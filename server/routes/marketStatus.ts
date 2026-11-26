import { STAGE_2A_INVARIANTS } from '@/server/config/featureGates';
import {
  DEFAULT_FEED_CHECKPOINT_KEY,
  type FeedCheckpointRecord,
} from '@/server/marketData/candleStore';
import {
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '@/server/marketData/registry';
import {
  MarketStatusResponseSchema,
  type FeedQuality,
  type MarketStatusResponse,
  type ProviderInstrument,
} from '@/shared/contracts/marketData';
import { evaluateFeedStatusFreshness } from '@/shared/utils/feedIntegrity';
import { toUtcIsoString } from '@/shared/utils/time';

function mergePersistedCheckpoint(params: {
  adapterName: string;
  providerVerified: boolean;
  instrument: ProviderInstrument | null;
  quality: FeedQuality;
  checkpoint: FeedCheckpointRecord | null;
  now: Date;
  staleThresholdSeconds?: number;
}): {
  adapterName: string;
  providerVerified: boolean;
  instrument: ProviderInstrument | null;
  quality: FeedQuality;
} {
  const { checkpoint } = params;
  // Never override NOT_CONFIGURED (zero-credential / MARKET_FEED_ENABLED=false) with historical checkpoint state
  if (!checkpoint || params.quality.state === 'NOT_CONFIGURED') {
    return {
      adapterName: params.adapterName,
      providerVerified: params.providerVerified,
      instrument: params.instrument,
      quality: params.quality,
    };
  }

  // Prefer in-process adapter telemetry if it is newer than the persisted checkpoint
  const adapterLastMs = params.quality.lastSuccessfulRequestUtc
    ? Date.parse(params.quality.lastSuccessfulRequestUtc)
    : -1;
  const checkpointLastMs = checkpoint.lastSuccessfulRequestUtc
    ? Date.parse(checkpoint.lastSuccessfulRequestUtc)
    : -1;

  if (adapterLastMs > checkpointLastMs) {
    return {
      adapterName: params.adapterName,
      providerVerified: params.providerVerified,
      instrument: params.instrument,
      quality: params.quality,
    };
  }

  const evaluated = evaluateFeedStatusFreshness({
    currentState: checkpoint.state,
    lastCompleteCandleCloseUtc: checkpoint.lastCompleteCandleCloseUtc,
    missingBarCount: checkpoint.missingBarCount,
    duplicateBarCount: checkpoint.duplicateBarCount,
    nowUtc: params.now,
    staleThresholdSeconds: params.staleThresholdSeconds,
    reasonCode: checkpoint.reasonCode,
    warnings: checkpoint.warnings,
  });

  const instrument: ProviderInstrument | null =
    params.instrument ??
    (checkpoint.providerVerified
      ? {
          displaySymbol: 'XAUUSD',
          providerName: checkpoint.adapterName,
          providerSymbol: checkpoint.providerSymbol,
          pricePrecision: null,
          pipLocation: null,
          verified: true,
          verifiedAtUtc: checkpoint.lastSuccessfulRequestUtc,
        }
      : null);

  return {
    adapterName: checkpoint.adapterName || params.adapterName,
    providerVerified: params.providerVerified || checkpoint.providerVerified,
    instrument,
    quality: {
      ...params.quality,
      state: evaluated.state,
      lastSuccessfulRequestUtc: checkpoint.lastSuccessfulRequestUtc,
      lastProviderCandleOpenUtc: checkpoint.lastProviderCandleOpenUtc,
      lastCompleteCandleCloseUtc: checkpoint.lastCompleteCandleCloseUtc,
      freshnessSeconds: evaluated.freshnessSeconds,
      missingBarCount: checkpoint.missingBarCount,
      duplicateBarCount: checkpoint.duplicateBarCount,
      warnings: evaluated.warnings,
      reasonCode: evaluated.reasonCode,
    },
  };
}

export async function buildMarketStatusPayload(
  now: Date = new Date(),
  runtime: MarketDataRuntime = resolveMarketDataRuntime()
): Promise<MarketStatusResponse> {
  const historyPersistence = await runtime.store.ensureReady();
  runtime.historyPersistence = historyPersistence;

  const status = await runtime.adapter.getStatus(now);
  let checkpoint: FeedCheckpointRecord | null = null;
  if (historyPersistence === 'POSTGRES_CONNECTED') {
    try {
      checkpoint = await runtime.store.getFeedCheckpoint(
        DEFAULT_FEED_CHECKPOINT_KEY
      );
    } catch {
      checkpoint = null;
    }
  }

  const merged = mergePersistedCheckpoint({
    adapterName: status.adapterName,
    providerVerified: status.providerVerified,
    instrument: status.instrument,
    quality: status.quality,
    checkpoint,
    now,
    staleThresholdSeconds: runtime.staleThresholdSeconds,
  });

  const persistenceError = runtime.store.getLastPersistenceError();
  const warnings =
    persistenceError && !merged.quality.warnings.includes(persistenceError)
      ? [...merged.quality.warnings, persistenceError]
      : merged.quality.warnings;

  return MarketStatusResponseSchema.parse({
    schemaVersion: '1.0.0',
    serverTimeUtc: toUtcIsoString(now),
    adapterName: merged.adapterName,
    providerVerified: merged.providerVerified,
    instrument: merged.instrument,
    quality: {
      ...merged.quality,
      warnings,
    },
    historyPersistence,
    backfillEnabled: runtime.backfillEnabled,
    crtEngineEnabled: STAGE_2A_INVARIANTS.crtEngineEnabled,
    signalsEnabled: STAGE_2A_INVARIANTS.signalsEnabled,
    orderExecutionEnabled: STAGE_2A_INVARIANTS.orderExecutionEnabled,
  });
}
