import {
  InstrumentsResponseSchema,
  type InstrumentsResponse,
} from '@/shared/contracts/api';
import { toUtcIsoString } from '@/shared/utils/time';

/**
 * Returns the Stage 1 configuration-only instrument registry.
 * XAUUSD is the sole enabled instrument; no price, quote, or feed assertion is included.
 */
export function buildInstrumentsPayload(
  now: Date = new Date()
): InstrumentsResponse {
  return InstrumentsResponseSchema.parse({
    data: [
      {
        key: 'XAUUSD',
        displayName: 'Gold / US Dollar (Spot Reference)',
        assetClass: 'PRECIOUS_METALS',
        enabled: true,
        marketDataConnected: false,
        backendFeedSymbol: null,
        displayChartSymbol: 'OANDA:XAUUSD',
        displayChartProvider: 'TRADINGVIEW_WIDGET',
        displayChartNote:
          'OANDA:XAUUSD is a TradingView chart display selection only and does not assert or connect a backend market-data provider.',
        supportedTimeframes: ['D1', 'H4', 'H1', 'M15'],
        futureTimeframes: ['M5'],
      },
    ],
    serverTimeUtc: toUtcIsoString(now),
  });
}
