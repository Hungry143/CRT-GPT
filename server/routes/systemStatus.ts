import { readFeatureGates } from '@/server/config/featureGates';
import {
  SystemStatusResponseSchema,
  type SystemStatusResponse,
} from '@/shared/contracts/api';
import { toUtcIsoString } from '@/shared/utils/time';

/**
 * Builds the Stage 1 system diagnostics payload.
 * Truthfulness rule: In Stage 1, no market-data adapter, CRT engine, or signal service
 * is provisioned, so state remains strictly NOT_CONFIGURED / DISABLED / RESEARCH_ONLY
 * with `orderExecutionEnabled: false` and `null` for all unavailable market telemetry.
 */
export function buildSystemStatusPayload(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env
): SystemStatusResponse {
  // Feature gates are evaluated server-side; in Stage 1 no provider/engine exists yet,
  // so unconfigured services remain honestly reported as NOT_CONFIGURED / DISABLED.
  const gates = readFeatureGates(env);
  const environment =
    env.NODE_ENV && env.NODE_ENV.trim().length > 0
      ? env.NODE_ENV.trim()
      : 'development';

  return SystemStatusResponseSchema.parse({
    schemaVersion: '1.0.0',
    environment,
    serverTimeUtc: toUtcIsoString(now),
    marketFeed: {
      state: gates.MARKET_FEED_ENABLED ? 'NOT_CONFIGURED' : 'NOT_CONFIGURED',
      provider: null,
      symbol: null,
      lastTickAtUtc: null,
      lastClosedBarAtUtc: null,
      quality: 'UNAVAILABLE',
    },
    crtEngine: {
      state: gates.CRT_ENGINE_ENABLED ? 'DISABLED' : 'DISABLED',
      ruleVersion: null,
    },
    signalService: {
      state: gates.SIGNALS_ENABLED ? 'DISABLED' : 'DISABLED',
      confirmedSignals: 0,
    },
    riskMode: 'RESEARCH_ONLY',
    orderExecutionEnabled: false,
  });
}
