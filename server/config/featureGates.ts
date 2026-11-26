import type { FeatureGateSnapshot } from '@/shared/contracts/api';

/**
 * Parses Stage 1 & Stage 2A feature gates from server environment variables.
 * All gates default strictly to false if unset or anything other than "true".
 * Note: In Stage 2A, CRT_ENGINE_ENABLED, SIGNALS_ENABLED, and orderExecutionEnabled
 * remain enforced server-side invariants (always disabled regardless of env flags).
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

export function readBackfillEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return parseBooleanFlag(env.BACKFILL_ENABLED);
}

/**
 * Enforced Stage 2A server-side safety invariants:
 * No CRT engine, no signals, and no order execution in Stage 2A.
 */
export const STAGE_2A_INVARIANTS = {
  crtEngineEnabled: false as const,
  signalsEnabled: false as const,
  orderExecutionEnabled: false as const,
};
