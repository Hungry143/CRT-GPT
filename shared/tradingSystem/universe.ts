import { z } from 'zod';

/**
 * Product-wide instrument universe. Prices, spreads, biases and signal counts
 * are intentionally absent: a configured symbol never implies a verified feed.
 */
export const INSTRUMENT_KEYS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD',
  'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'EURCHF',
  'XAUUSD', 'XAGUSD',
] as const;

export const InstrumentKeySchema = z.enum(INSTRUMENT_KEYS);
export type InstrumentKey = z.infer<typeof InstrumentKeySchema>;
export const INSTRUMENT_TIMEFRAMES = ['D1', 'H4', 'H1', 'M15'] as const;
export type InstrumentTimeframe = (typeof INSTRUMENT_TIMEFRAMES)[number];

export const UniverseInstrumentSchema = z.object({
  key: InstrumentKeySchema,
  displayName: z.string().min(1),
  assetClass: z.enum(['FOREX', 'PRECIOUS_METALS']),
  chartSymbol: z.string().min(1),
  chartProvider: z.literal('TRADINGVIEW_WIDGET'),
  backendFeedVerified: z.literal(false),
  configuredTimeframes: z.tuple([
    z.literal('D1'), z.literal('H4'), z.literal('H1'), z.literal('M15'),
  ]),
}).strict();

export type UniverseInstrument = z.infer<typeof UniverseInstrumentSchema>;

const forex = (key: InstrumentKey, displayName: string): UniverseInstrument => ({
  key,
  displayName,
  assetClass: 'FOREX',
  chartSymbol: 'OANDA:' + key,
  chartProvider: 'TRADINGVIEW_WIDGET',
  backendFeedVerified: false,
  configuredTimeframes: ['D1', 'H4', 'H1', 'M15'],
});

const metals = (key: InstrumentKey, displayName: string): UniverseInstrument => ({
  ...forex(key, displayName),
  assetClass: 'PRECIOUS_METALS',
});

export const TRADING_UNIVERSE: readonly UniverseInstrument[] = [
  forex('EURUSD', 'Euro / US Dollar'),
  forex('GBPUSD', 'British Pound / US Dollar'),
  forex('USDJPY', 'US Dollar / Japanese Yen'),
  forex('USDCHF', 'US Dollar / Swiss Franc'),
  forex('USDCAD', 'US Dollar / Canadian Dollar'),
  forex('AUDUSD', 'Australian Dollar / US Dollar'),
  forex('NZDUSD', 'New Zealand Dollar / US Dollar'),
  forex('EURGBP', 'Euro / British Pound'),
  forex('EURJPY', 'Euro / Japanese Yen'),
  forex('GBPJPY', 'British Pound / Japanese Yen'),
  forex('AUDJPY', 'Australian Dollar / Japanese Yen'),
  forex('EURCHF', 'Euro / Swiss Franc'),
  metals('XAUUSD', 'Gold / US Dollar'),
  metals('XAGUSD', 'Silver / US Dollar'),
] as const;

export const UniverseResponseSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  serverTimeUtc: z.string().datetime(),
  data: z.array(UniverseInstrumentSchema).length(14),
  dataDisclaimer: z.literal(
    'Chart symbols are visual-only; no backend price, signal or execution readiness is implied.'
  ),
}).strict();
export type UniverseResponse = z.infer<typeof UniverseResponseSchema>;

export function getUniverseInstrument(key: InstrumentKey): UniverseInstrument {
  const instrument = TRADING_UNIVERSE.find((item) => item.key === key);
  if (!instrument) throw new Error('Unsupported instrument');
  return instrument;
}
