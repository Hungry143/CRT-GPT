import { z } from 'zod';
import { InstrumentKeySchema } from '@/shared/tradingSystem/universe';

/**
 * Shared Stage 1 & Future-Extensible API Contracts for CRT Intelligence.
 * Rule: Encode "no data" strictly as `null`, never as an invented zero or placeholder quote.
 */

export const FeedStateSchema = z.enum([
  'NOT_CONFIGURED',
  'DISCONNECTED',
  'CONNECTING',
  'DEGRADED',
  'CONNECTED',
]);
export type FeedState = z.infer<typeof FeedStateSchema>;

export const EngineStateSchema = z.enum([
  'DISABLED',
  'AWAITING_FEED',
  'IDLE',
  'RUNNING',
  'ERROR',
]);
export type EngineState = z.infer<typeof EngineStateSchema>;

export const SignalServiceStateSchema = z.enum([
  'DISABLED',
  'ACTIVE',
  'PAUSED',
  'ERROR',
]);
export type SignalServiceState = z.infer<typeof SignalServiceStateSchema>;

export const SignalsEndpointStateSchema = z.enum([
  'ENGINE_DISABLED',
  'AWAITING_FEED',
  'READY',
]);
export type SignalsEndpointState = z.infer<typeof SignalsEndpointStateSchema>;

export const SignalStateSchema = z.enum([
  'forming',
  'pending',
  'confirmed',
  'invalidated',
  'expired',
]);
export type SignalState = z.infer<typeof SignalStateSchema>;

export const CandleQualitySchema = z.enum([
  'UNAVAILABLE',
  'STALE',
  'PARTIAL',
  'VERIFIED',
]);
export type CandleQuality = z.infer<typeof CandleQualitySchema>;

export const RiskModeSchema = z.enum(['RESEARCH_ONLY']);
export type RiskMode = z.infer<typeof RiskModeSchema>;

export const TimeframeCodeSchema = z.enum(['D1', 'H4', 'H1', 'M15', 'M5']);
export type TimeframeCode = z.infer<typeof TimeframeCodeSchema>;

/**
 * Future-only domain contract for OHLCV bars once a verified MarketDataAdapter is integrated.
 * Not populated in Stage 1.
 */
export const CandleSchema = z.object({
  instrument: z.string(),
  timeframe: TimeframeCodeSchema,
  openTimeUtc: z.string().datetime(),
  closeTimeUtc: z.string().datetime(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nullable(),
  isClosed: z.boolean(),
});
export type Candle = z.infer<typeof CandleSchema>;

/**
 * Future-only domain contract for source-validated CRT rule evidence.
 * Not populated in Stage 1.
 */
export const RuleEvidenceSchema = z.object({
  ruleId: z.string(),
  sourceDocument: z.string(),
  timeframe: TimeframeCodeSchema,
  observedAtUtc: z.string().datetime(),
  summary: z.string(),
  passed: z.boolean(),
});
export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;

/**
 * Future-only discretionary signal contract.
 * Not populated in Stage 1; order execution is never supported.
 */
export const SignalSchema = z.object({
  id: z.string(),
  instrument: InstrumentKeySchema,
  state: SignalStateSchema,
  direction: z.enum(['LONG', 'SHORT']).nullable(),
  htfTimeframe: z.enum(['D1', 'H4']),
  ltfTimeframe: z.enum(['H1', 'M15']),
  createdAtUtc: z.string().datetime(),
  updatedAtUtc: z.string().datetime(),
  ruleVersion: z.string(),
  evidence: z.array(RuleEvidenceSchema),
});
export type Signal = z.infer<typeof SignalSchema>;

/**
 * Configuration-only instrument contract.
 * Explicitly contains NO price, bid/ask, spread, or derived quote fields.
 */
export const InstrumentConfigSchema = z
  .object({
    key: InstrumentKeySchema,
    displayName: z.string(),
    assetClass: z.enum(['FOREX', 'PRECIOUS_METALS']),
    enabled: z.boolean(),
    marketDataConnected: z.boolean(),
    backendFeedSymbol: z.string().nullable(),
    displayChartSymbol: z.string(),
    displayChartProvider: z.literal('TRADINGVIEW_WIDGET'),
    displayChartNote: z.string(),
    supportedTimeframes: z.array(z.enum(['D1', 'H4', 'H1', 'M15'])),
    futureTimeframes: z.array(z.enum(['M5'])),
  })
  .strict();
export type InstrumentConfig = z.infer<typeof InstrumentConfigSchema>;

export const HealthResponseSchema = z
  .object({
    service: z.literal('crt-intelligence'),
    version: z.literal('0.1.0'),
    status: z.literal('ok'),
    serverTimeUtc: z.string().datetime(),
  })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const MarketFeedStatusSchema = z
  .object({
    state: FeedStateSchema,
    provider: z.string().nullable(),
    symbol: z.string().nullable(),
    lastTickAtUtc: z.string().datetime().nullable(),
    lastClosedBarAtUtc: z.string().datetime().nullable(),
    quality: CandleQualitySchema,
  })
  .strict();
export type MarketFeedStatus = z.infer<typeof MarketFeedStatusSchema>;

export const CrtEngineStatusSchema = z
  .object({
    state: EngineStateSchema,
    ruleVersion: z.string().nullable(),
  })
  .strict();
export type CrtEngineStatus = z.infer<typeof CrtEngineStatusSchema>;

export const SignalServiceStatusSchema = z
  .object({
    state: SignalServiceStateSchema,
    confirmedSignals: z.number().int().min(0),
  })
  .strict();
export type SignalServiceStatus = z.infer<typeof SignalServiceStatusSchema>;

export const SystemStatusResponseSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    environment: z.string(),
    serverTimeUtc: z.string().datetime(),
    marketFeed: MarketFeedStatusSchema,
    crtEngine: CrtEngineStatusSchema,
    signalService: SignalServiceStatusSchema,
    riskMode: RiskModeSchema,
    orderExecutionEnabled: z.literal(false),
  })
  .strict();
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;

export const InstrumentsResponseSchema = z
  .object({
    data: z.array(InstrumentConfigSchema),
    serverTimeUtc: z.string().datetime(),
  })
  .strict();
export type InstrumentsResponse = z.infer<typeof InstrumentsResponseSchema>;

export const SignalsResponseSchema = z
  .object({
    data: z.array(SignalSchema),
    state: SignalsEndpointStateSchema,
  })
  .strict();
export type SignalsResponse = z.infer<typeof SignalsResponseSchema>;

export interface FeatureGateSnapshot {
  MARKET_FEED_ENABLED: boolean;
  CRT_ENGINE_ENABLED: boolean;
  SIGNALS_ENABLED: boolean;
  BACKFILL_ENABLED?: boolean;
}

export * from './marketData';
