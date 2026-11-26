import { InstrumentsResponseSchema, type InstrumentsResponse } from '@/shared/contracts/api';
import { TRADING_UNIVERSE } from '@/shared/tradingSystem/universe';
import { toUtcIsoString } from '@/shared/utils/time';

/**
 * Complete 14-instrument configuration registry. NEVER interpret as live coverage.
 * The legacy XAUUSD-only candle service still has its own explicit data boundary.
 */
export function buildInstrumentsPayload(now: Date = new Date()): InstrumentsResponse {
  return InstrumentsResponseSchema.parse({
    data: TRADING_UNIVERSE.map((instrument) => ({
      key: instrument.key,
      displayName: instrument.displayName,
      assetClass: instrument.assetClass,
      enabled: true,
      marketDataConnected: false,
      backendFeedSymbol: null,
      displayChartSymbol: instrument.chartSymbol,
      displayChartProvider: 'TRADINGVIEW_WIDGET' as const,
      displayChartNote: instrument.chartSymbol +
        ' is a third-party visualization choice only; backend instrument feed not connected.',
      supportedTimeframes: ['D1', 'H4', 'H1', 'M15'] as const,
      futureTimeframes: ['M5'] as const,
    })),
    serverTimeUtc: toUtcIsoString(now),
  });
}
