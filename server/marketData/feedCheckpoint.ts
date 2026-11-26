import { createHash } from 'node:crypto';
import type {
  FeedQuality,
  HistoryPersistenceState,
  PriceBasis,
  ProviderInstrument,
} from '@/shared/contracts/marketData';
import { evaluateFeedStatusFreshness } from '@/shared/utils/feedIntegrity';
import type { VerifiedMarketSchedule } from '@/shared/utils/sessionClock';
import {
  DEFAULT_FEED_CHECKPOINT_KEY,
  type FeedCheckpointRecord,
} from '@/server/marketData/candleStore';
import type { MarketDataRuntime } from '@/server/marketData/registry';

/**
 * Canonical, non-secret identity describing a configured market-data feed.
 * Uses a one-way SHA-256 hash of accountId (never the raw account ID or token)
 * so switching provider, environment, account, symbol, price basis, or alignment
 * policy invalidates stale checkpoints from prior configurations.
 */
export interface FeedConfigIdentity {
  readonly configIdentityHash: string;
  readonly provider: string;
  readonly providerEnv: string | null;
  readonly providerDivision: string | null;
  readonly accountScopeHash: string | null;
  readonly providerSymbol: string | null;
  readonly priceBasis: PriceBasis;
  readonly policyVersion: string;
}

export function buildFeedConfigIdentity(input: {
  provider: string;
  providerEnv?: string | null;
  providerDivision?: string | null;
  accountId?: string | null;
  providerSymbol?: string | null;
  priceBasis: PriceBasis;
  policyVersion: string;
}): FeedConfigIdentity {
  const provider = input.provider.trim().toLowerCase() || 'none';
  const providerEnv = input.providerEnv?.trim().toLowerCase() || null;
  const providerDivision = input.providerDivision?.trim().toUpperCase() || null;
  const accountScopeHash =
    input.accountId && input.accountId.trim().length > 0
      ? createHash('sha256')
          .update(`acct:${input.accountId.trim()}`)
          .digest('hex')
          .slice(0, 16)
      : null;
  const providerSymbol = input.providerSymbol?.trim().toUpperCase() || null;

  const canonical = JSON.stringify({
    provider,
    providerEnv,
    providerDivision,
    accountScopeHash,
    providerSymbol,
    priceBasis: input.priceBasis,
    policyVersion: input.policyVersion,
  });
  const configIdentityHash = createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 24);

  return {
    configIdentityHash,
    provider,
    providerEnv,
    providerDivision,
    accountScopeHash,
    providerSymbol,
    priceBasis: input.priceBasis,
    policyVersion: input.policyVersion,
  };
}

export function isCheckpointMatchingIdentity(
  checkpoint: FeedCheckpointRecord,
  identity: FeedConfigIdentity
): boolean {
  if (!checkpoint.configIdentityHash) {
    return false;
  }
  if (checkpoint.configIdentityHash !== identity.configIdentityHash) {
    return false;
  }
  if (checkpoint.provider && checkpoint.provider !== identity.provider) {
    return false;
  }
  if (
    checkpoint.providerEnv !== undefined &&
    checkpoint.providerEnv !== null &&
    checkpoint.providerEnv !== identity.providerEnv
  ) {
    return false;
  }
  if (
    checkpoint.accountScopeHash !== undefined &&
    checkpoint.accountScopeHash !== null &&
    checkpoint.accountScopeHash !== identity.accountScopeHash
  ) {
    return false;
  }
  if (checkpoint.priceBasis && checkpoint.priceBasis !== identity.priceBasis) {
    return false;
  }
  if (
    checkpoint.policyVersion &&
    checkpoint.policyVersion !== identity.policyVersion
  ) {
    return false;
  }
  if (
    identity.providerSymbol &&
    checkpoint.providerSymbol &&
    checkpoint.providerSymbol !== identity.providerSymbol
  ) {
    return false;
  }
  return true;
}

export interface EffectiveFeedStatus {
  adapterName: string;
  providerVerified: boolean;
  instrument: ProviderInstrument | null;
  quality: FeedQuality;
  historyPersistence: HistoryPersistenceState;
  usedDurableCheckpoint: boolean;
  checkpointIdentityMismatch: boolean;
  activeConfigIdentityHash: string;
  activeProvider: string;
  activeProviderEnv: string | null;
  activeAccountScopeHash: string | null;
  activeProviderSymbol: string | null;
  activePriceBasis: PriceBasis;
}

/**
 * Unified feed-status resolver shared by `/api/market/status`, `/api/market/candles`,
 * and `/api/market/session`.
 *
 * Guarantees:
 * - Zero-credential / disabled feeds (`NOT_CONFIGURED`) never inherit durable checkpoints.
 * - Cross-process worker checkpoints are accepted ONLY when `configIdentityHash` (provider,
 *   environment, account scope hash, provider symbol, price basis, policy version) matches
 *   the active runtime identity.
 * - Accepted checkpoints are re-evaluated against `now` and the authoritative market-session
 *   closure policy so stale or gapped checkpoints fail closed consistently everywhere.
 */
export async function resolveEffectiveFeedStatus(
  now: Date,
  runtime: MarketDataRuntime,
  options: {
    verifiedSchedule?: VerifiedMarketSchedule | null;
    staleThresholdSeconds?: number;
    checkpointKey?: string;
  } = {}
): Promise<EffectiveFeedStatus> {
  const historyPersistence = await runtime.store.ensureReady();
  runtime.historyPersistence = historyPersistence;

  const adapterStatus = await runtime.adapter.getStatus(now);
  const schedule = options.verifiedSchedule ?? runtime.closurePolicy ?? null;
  const staleThresholdSeconds =
    options.staleThresholdSeconds ?? runtime.staleThresholdSeconds;
  const checkpointKey = options.checkpointKey ?? DEFAULT_FEED_CHECKPOINT_KEY;

  const baseResult = (
    overrides: Partial<EffectiveFeedStatus> = {}
  ): EffectiveFeedStatus => {
    const persistenceError = runtime.store.getLastPersistenceError();
    const baseQuality = overrides.quality ?? adapterStatus.quality;
    const warnings =
      persistenceError && !baseQuality.warnings.includes(persistenceError)
        ? [...baseQuality.warnings, persistenceError]
        : baseQuality.warnings;

    return {
      adapterName: overrides.adapterName ?? adapterStatus.adapterName,
      providerVerified:
        overrides.providerVerified ?? adapterStatus.providerVerified,
      instrument:
        overrides.instrument !== undefined
          ? overrides.instrument
          : adapterStatus.instrument,
      quality: {
        ...baseQuality,
        warnings,
      },
      historyPersistence,
      usedDurableCheckpoint: overrides.usedDurableCheckpoint ?? false,
      checkpointIdentityMismatch:
        overrides.checkpointIdentityMismatch ?? false,
      activeConfigIdentityHash: runtime.configIdentity.configIdentityHash,
      activeProvider: runtime.configIdentity.provider,
      activeProviderEnv: runtime.configIdentity.providerEnv,
      activeAccountScopeHash: runtime.configIdentity.accountScopeHash,
      activeProviderSymbol:
        (overrides.instrument !== undefined
          ? overrides.instrument
          : adapterStatus.instrument
        )?.providerSymbol ?? runtime.configIdentity.providerSymbol,
      activePriceBasis: runtime.configIdentity.priceBasis,
    };
  };

  // Never reconcile durable checkpoints when the feed is unconfigured/disabled
  if (adapterStatus.quality.state === 'NOT_CONFIGURED') {
    return baseResult();
  }

  let checkpoint: FeedCheckpointRecord | null = null;
  try {
    checkpoint = await runtime.store.getFeedCheckpoint(checkpointKey);
  } catch {
    checkpoint = null;
  }

  if (!checkpoint) {
    return baseResult();
  }

  // Strictly reject checkpoints written by a different provider, account, symbol, or price basis
  if (!isCheckpointMatchingIdentity(checkpoint, runtime.configIdentity)) {
    const mismatchWarn =
      'Ignored durable feed checkpoint from a different provider, account, symbol, or price-basis configuration.';
    const warnings = adapterStatus.quality.warnings.includes(mismatchWarn)
      ? adapterStatus.quality.warnings
      : [...adapterStatus.quality.warnings, mismatchWarn];

    return baseResult({
      checkpointIdentityMismatch: true,
      quality: {
        ...adapterStatus.quality,
        warnings,
      },
    });
  }

  // Prefer in-process adapter telemetry only if it is strictly newer than the durable checkpoint
  const adapterLastMs = adapterStatus.quality.lastSuccessfulRequestUtc
    ? Date.parse(adapterStatus.quality.lastSuccessfulRequestUtc)
    : -1;
  const checkpointLastMs = checkpoint.lastSuccessfulRequestUtc
    ? Date.parse(checkpoint.lastSuccessfulRequestUtc)
    : -1;

  if (adapterLastMs > checkpointLastMs) {
    return baseResult();
  }

  const evaluated = evaluateFeedStatusFreshness({
    currentState: checkpoint.state,
    lastCompleteCandleCloseUtc: checkpoint.lastCompleteCandleCloseUtc,
    missingBarCount: checkpoint.missingBarCount,
    duplicateBarCount: checkpoint.duplicateBarCount,
    nowUtc: now,
    staleThresholdSeconds,
    verifiedSchedule: schedule,
    reasonCode: checkpoint.reasonCode,
    warnings: checkpoint.warnings,
  });

  const instrument: ProviderInstrument | null =
    adapterStatus.instrument ??
    (checkpoint.providerVerified
      ? {
          displaySymbol: 'XAUUSD',
          providerName:
            checkpoint.provider ?? runtime.configIdentity.provider,
          providerSymbol:
            checkpoint.providerSymbol ??
            runtime.configIdentity.providerSymbol,
          pricePrecision: null,
          pipLocation: null,
          verified: true,
          verifiedAtUtc: checkpoint.lastSuccessfulRequestUtc,
        }
      : null);

  return baseResult({
    adapterName: checkpoint.adapterName || adapterStatus.adapterName,
    providerVerified:
      adapterStatus.providerVerified || checkpoint.providerVerified,
    instrument,
    usedDurableCheckpoint: true,
    quality: {
      ...adapterStatus.quality,
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
  });
}
