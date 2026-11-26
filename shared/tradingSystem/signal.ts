import { z } from 'zod';
import { InstrumentKeySchema } from '@/shared/tradingSystem/universe';

/**
 * Whole-platform signal contracts. An artifact cannot be treated as a trade idea
 * without a verified data snapshot and a source-versioned CRT rule evaluation.
 * No API endpoint in this change emits or executes signals.
 */
export const CrtSetupSchema = z.enum(['EXPANSION', 'REVERSAL']);
export const SignalLifecycleSchema = z.enum([
  'FORMING', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'INVALIDATED',
  'EXPIRED', 'ENTRY_TRIGGERED', 'TP1_HIT', 'TP2_HIT', 'SL_HIT', 'CLOSED',
]);
export const DataQualitySchema = z.enum([
  'VERIFIED', 'STALE', 'GAPPED', 'MISMATCH', 'UNAVAILABLE',
]);
export const RuleGateIdSchema = z.enum([
  'G0_SOURCE', 'G1_SESSION', 'G2_MARKET_PROFILE', 'G3_HTF_RANGE',
  'G4_LIQUIDITY', 'G5_STRUCTURE', 'G6_ENTRY_MODEL', 'G7_RISK',
]);
export const GateOutcomeSchema = z.enum(['PASS', 'FAIL', 'UNKNOWN']);
export const EntryModelSchema = z.enum([
  'ORDER_BLOCK', 'FAIR_VALUE_GAP', 'TURTLE_SOUP', 'KISS_OF_DEATH',
]);

export const GateEvidenceSchema = z.object({
  gate: RuleGateIdSchema,
  outcome: GateOutcomeSchema,
  ruleId: z.string().min(1),
  ruleVersion: z.string().min(1),
  observedAtUtc: z.string().datetime(),
  timeframe: z.enum(['D1', 'H4', 'H1', 'M15', 'M5']).nullable(),
  sourceCandleIds: z.array(z.string()).min(1),
  explanation: z.string().min(1),
}).strict();

export const VerifiedSnapshotSchema = z.object({
  instrument: InstrumentKeySchema,
  provider: z.string().min(1),
  providerSymbol: z.string().min(1),
  configIdentityHash: z.string().min(16),
  checkedAtUtc: z.string().datetime(),
  lastCompletedM15Utc: z.string().datetime(),
  dataQuality: z.literal('VERIFIED'),
  crossSourceAudit: z.enum(['CONSISTENT', 'NOT_APPLICABLE']),
  snapshotHash: z.string().min(16),
}).strict();

export const PriceLevelSchema = z.string().regex(/^\d+(?:\.\d+)?$/, 'Decimal price required');
export const CrtSignalSchema = z.object({
  id: z.string().min(1),
  instrument: InstrumentKeySchema,
  mode: CrtSetupSchema,
  direction: z.enum(['LONG', 'SHORT']),
  entryModel: EntryModelSchema,
  lifecycle: SignalLifecycleSchema,
  grade: z.enum(['A', 'B', 'C']),
  score: z.number().int().min(0).max(100),
  createdAtUtc: z.string().datetime(),
  confirmedAtUtc: z.string().datetime().nullable(),
  validUntilUtc: z.string().datetime(),
  updatedAtUtc: z.string().datetime(),
  entry: PriceLevelSchema,
  stopLoss: PriceLevelSchema,
  tp1: PriceLevelSchema,
  tp2: PriceLevelSchema,
  netRiskReward: z.number().positive(),
  riskPercent: z.number().positive().max(5),
  rulebookVersion: z.string().min(1),
  snapshot: VerifiedSnapshotSchema,
  gates: z.array(GateEvidenceSchema).length(8),
  narrative: z.string().min(1),
}).strict().superRefine((signal, ctx) => {
  const ids = new Set(signal.gates.map(g => g.gate));
  if (ids.size !== 8 || signal.gates.some(g => g.outcome !== 'PASS')) {
    ctx.addIssue({ code: 'custom', message: 'All eight distinct gates must PASS for an emitted signal' });
  }
  if (Date.parse(signal.validUntilUtc) <= Date.parse(signal.createdAtUtc)) {
    ctx.addIssue({ code: 'custom', message: 'Signal expiration must follow creation' });
  }
  if (signal.lifecycle === 'CONFIRMED' && !signal.confirmedAtUtc) {
    ctx.addIssue({ code: 'custom', message: 'Confirmed signals require confirmedAtUtc' });
  }
  const entry = Number(signal.entry);
  const sl = Number(signal.stopLoss);
  const tp1 = Number(signal.tp1);
  const tp2 = Number(signal.tp2);
  const correctOrder = signal.direction === 'LONG'
    ? sl < entry && entry < tp1 && tp1 <= tp2
    : tp2 <= tp1 && tp1 < entry && entry < sl;
  if (!correctOrder) {
    ctx.addIssue({ code: 'custom', message: 'Entry, stop and targets violate trade direction' });
  }
  if (signal.netRiskReward < 2) {
    ctx.addIssue({ code: 'custom', message: 'Net RR below 2.0 must not be emitted' });
  }
});
export type CrtSignal = z.infer<typeof CrtSignalSchema>;

export const SignalJournalEventSchema = z.object({
  signalId: z.string().min(1),
  instrument: InstrumentKeySchema,
  occurredAtUtc: z.string().datetime(),
  previousState: SignalLifecycleSchema,
  nextState: SignalLifecycleSchema,
  observationSource: z.string().min(1),
  evidenceSnapshotHash: z.string().min(16),
  observedBid: PriceLevelSchema.nullable(),
  observedAsk: PriceLevelSchema.nullable(),
  reasonCode: z.string().min(1),
}).strict();

export const UniverseSignalReadinessSchema = z.object({
  instrument: InstrumentKeySchema,
  marketData: DataQualitySchema,
  crtRulesVerified: z.boolean(),
  latestClosedBarAtUtc: z.string().datetime().nullable(),
  candidateCount: z.number().int().min(0),
  confirmedCount: z.number().int().min(0),
  reasonCode: z.string().min(1),
}).strict();
