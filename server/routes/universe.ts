import {
  TRADING_UNIVERSE,
  UniverseResponseSchema,
  type UniverseResponse,
} from '@/shared/tradingSystem/universe';

export function buildUniversePayload(now: Date = new Date()): UniverseResponse {
  return UniverseResponseSchema.parse({
    schemaVersion: '1.0.0',
    serverTimeUtc: now.toISOString(),
    data: TRADING_UNIVERSE,
    dataDisclaimer:
      'Chart symbols are visual-only; no backend price, signal or execution readiness is implied.',
  });
}
