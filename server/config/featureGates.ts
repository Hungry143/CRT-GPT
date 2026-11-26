import type { FeatureGateSnapshot } from '@/shared/contracts/api';

/**
 * Parses Stage 1 feature gates from server environment variables.
 * Rule 7: `MARKET_FEED_ENABLED=false`, `CRT_ENGINE_ENABLED=false`, `SIGNALS_ENABLED=false`.
 * If unset or anything other than exact lowercase "true", treat strictly as false.
 */
function parseBooleanFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function readFeatureGates(
  env: Record<string, string | undefined> = process.env
): FeatureGateSnapshot {
  return {
    MARKET_FEED_ENABLED: parseBooleanFlag(env.MARKET_FEED_ENABLED),
    CRT_ENGINE_ENABLED: parseBooleanFlag(env.CRT_ENGINE_ENABLED),
    SIGNALS_ENABLED: parseBooleanFlag(env.SIGNALS_ENABLED),
  };
}
