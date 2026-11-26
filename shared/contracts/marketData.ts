import { z } from 'zod';

/**
 * Stage 2A Canonical Market-Data Contracts.
 * Rules:
 * - Provider-neutral schemas; UI and future engine must never depend on raw provider DTOs.
 * - Unknown numeric/timestamp telemetry is encoded strictly as `null`, never `0`.
 * - Prices are stored as validated positive decimal strings to preserve exact precision.
 * - Completed-candle APIs expose ONLY finalized completed bars (`complete: true`).
 */

export const MarketDataProviderStateSchema = z.enum([
  'NOT_CONFIGURED',
  'CONNECTING',
  'CONNECTED',
  'STALE',
  'AUTH_ERROR',
  'INSTRUMENT_UNAVAILABLE',
  'ERROR',
  'MARKET_CLOSED',
]);
export type MarketDataProviderState = z.infer<
  typeof MarketDataProviderStateSchema
>;

export const PriceBasisSchema = z.enum(['MID', 'BID', 'ASK']);
export type PriceBasis = z.infer<typeof PriceBasisSchema>;

/**
 * Display research granularities: D1, H4, H1, M15.
 * M1 is included for historical replay / intrabar ordering retention.
 * M5 is explicitly deferred to a later stage.
 */
export const MarketGranularitySchema = z.enum(['D1', 'H4', 'H1', 'M15', 'M1']);
export type MarketGranularity = z.infer<typeof MarketGranularitySchema>;

export const DISPLAY_RESEARCH_GRANULARITIES: readonly MarketGranularity[] = [
  'D1',
  'H4',
  'H1',
  'M15',
] as const;

export const HistoryPersistenceStateSchema = z.enum([
  'NOT_PERSISTENT',
  'POSTGRES_CONFIGURED',
  'POSTGRES_CONNECTED',
]);
export type HistoryPersistenceState = z.infer<
  typeof HistoryPersistenceStateSchema
>;

export const ExpectedMarketScheduleStateSchema = z.enum([
  'OPEN_EXPECTED',
  'WEEKEND_CLOSED',
  'HOLIDAY_CLOSED',
  'UNKNOWN',
]);
export type ExpectedMarketScheduleState = z.infer<
  typeof ExpectedMarketScheduleStateSchema
>;

export const ObservedMarketAvailabilitySchema = z.enum([
  'UNOBSERVED_NO_FEED',
  'OBSERVED_ACTIVE',
  'OBSERVED_STALE',
  'OBSERVED_CLOSED',
]);
export type ObservedMarketAvailability = z.infer<
  typeof ObservedMarketAvailabilitySchema
>;

const PositiveDecimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a valid unsigned decimal string')
  .refine((val) => Number(val) > 0, 'Price value must be strictly positive');

export const ProviderInstrumentSchema = z
  .object({
    displaySymbol: z.literal('XAUUSD'),
    providerName: z.string(),
    providerSymbol: z.string().nullable(),
    pricePrecision: z.number().int().min(0).max(10).nullable(),
    pipLocation: z.number().int().min(-10).max(10).nullable(),
    minTradeSize: z.string().nullable().optional(),
    verified: z.boolean(),
    verifiedAtUtc: z.string().datetime().nullable(),
  })
  .strict();
export type ProviderInstrument = z.infer<typeof ProviderInstrumentSchema>;

/**
 * Canonical provider-neutral normalized OHLC candle.
 * Note: `volume` represents provider tick/price update count, NOT exchange-traded volume.
 */
export const NormalizedCandleSchema = z
  .object({
    provider: z.string().min(1),
    providerSymbol: z.string().min(1),
    granularity: MarketGranularitySchema,
    priceBasis: PriceBasisSchema,
    openTimeUtc: z.string().datetime(),
    closeTimeUtc: z.string().datetime(),
    open: PositiveDecimalStringSchema,
    high: PositiveDecimalStringSchema,
    low: PositiveDecimalStringSchema,
    close: PositiveDecimalStringSchema,
    volume: z.number().int().min(0).nullable(),
    complete: z.boolean(),
    sourceRetrievedAtUtc: z.string().datetime(),
    sourceCandleId: z.string().min(1),
  })
  .strict();
export type NormalizedCandle = z.infer<typeof NormalizedCandleSchema>;

export const AlignmentPolicySchema = z
  .object({
    policyVersion: z.string(),
    dailyRollHourNy: z.literal(17),
    alignmentTimezone: z.literal('America/New_York'),
    userDisplayTimezone: z.literal('Asia/Kolkata'),
    weeklyAlignment: z.enum(['Friday']).nullable(),
    priceBasis: PriceBasisSchema,
    smooth: z.literal(false),
    h4LocalAnchorsNy: z.array(z.string()),
    publicationGraceSeconds: z.number().int().min(0),
    midpointSemanticsNote: z.string(),
  })
  .strict();
export type AlignmentPolicy = z.infer<typeof AlignmentPolicySchema>;

export const FeedQualitySchema = z
  .object({
    state: MarketDataProviderStateSchema,
    lastSuccessfulRequestUtc: z.string().datetime().nullable(),
    lastProviderCandleOpenUtc: z.string().datetime().nullable(),
    lastCompleteCandleCloseUtc: z.string().datetime().nullable(),
    freshnessSeconds: z.number().min(0).nullable(),
    missingBarCount: z.number().int().min(0).nullable(),
    duplicateBarCount: z.number().int().min(0).nullable(),
    alignmentPolicy: AlignmentPolicySchema,
    warnings: z.array(z.string()),
    reasonCode: z.string().nullable(),
  })
  .strict();
export type FeedQuality = z.infer<typeof FeedQualitySchema>;

export const SessionBoundarySchema = z
  .object({
    granularity: z.enum(['M15', 'H1', 'H4', 'D1']),
    nextBoundaryUtc: z.string().datetime(),
    nextBoundaryNyLocal: z.string(),
    secondsRemaining: z.number().int().min(0),
  })
  .strict();
export type SessionBoundary = z.infer<typeof SessionBoundarySchema>;

export const SessionClockSnapshotSchema = z
  .object({
    nowUtc: z.string().datetime(),
    nyDate: z.string(),
    nyLocalTime: z.string(),
    nyOffset: z.string(),
    nyAbbreviation: z.string(),
    isDstActive: z.boolean(),
    istDate: z.string(),
    istDisplayTime: z.string(),
    istOffset: z.string(),
    alignmentPolicy: AlignmentPolicySchema,
    nextBoundaries: z.array(SessionBoundarySchema),
    expectedMarketScheduleState: ExpectedMarketScheduleStateSchema,
    observedMarketAvailability: ObservedMarketAvailabilitySchema,
    timezoneDisclaimer: z.string(),
  })
  .strict();
export type SessionClockSnapshot = z.infer<typeof SessionClockSnapshotSchema>;

export const MarketStatusResponseSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    serverTimeUtc: z.string().datetime(),
    adapterName: z.string(),
    providerVerified: z.boolean(),
    instrument: ProviderInstrumentSchema.nullable(),
    quality: FeedQualitySchema,
    historyPersistence: HistoryPersistenceStateSchema,
    backfillEnabled: z.boolean(),
    crtEngineEnabled: z.literal(false),
    signalsEnabled: z.literal(false),
    orderExecutionEnabled: z.literal(false),
  })
  .strict();
export type MarketStatusResponse = z.infer<typeof MarketStatusResponseSchema>;

export const MarketCandlesResponseSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    serverTimeUtc: z.string().datetime(),
    instrument: z.literal('XAUUSD'),
    granularity: MarketGranularitySchema,
    status: MarketDataProviderStateSchema,
    completedOnly: z.literal(true),
    data: z.array(NormalizedCandleSchema),
    count: z.number().int().min(0),
    limit: z.number().int().min(1).max(500),
    reasonCode: z.string().nullable(),
  })
  .strict();
export type MarketCandlesResponse = z.infer<typeof MarketCandlesResponseSchema>;

export const MarketSessionResponseSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    serverTimeUtc: z.string().datetime(),
    session: SessionClockSnapshotSchema,
  })
  .strict();
export type MarketSessionResponse = z.infer<typeof MarketSessionResponseSchema>;

export const CandleRevisionEventSchema = z
  .object({
    sourceCandleId: z.string(),
    detectedAtUtc: z.string().datetime(),
    changedFields: z.array(z.string()),
    previousClose: z.string(),
    revisedClose: z.string(),
  })
  .strict();
export type CandleRevisionEvent = z.infer<typeof CandleRevisionEventSchema>;
