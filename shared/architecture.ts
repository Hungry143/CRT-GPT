/**
 * Architectural module registry across CRT Intelligence build milestones.
 * Stage 2A implements read-only market-data contracts, adapter skeletons, DST-safe SessionClock,
 * CandleValidator, CandleStore, and BackfillService interface — while keeping all CRT
 * detection, signal generation, risk sizing, and order execution strictly disabled.
 */

export interface PlannedModuleSpec {
  id:
    | 'MarketDataAdapter'
    | 'CandleValidator'
    | 'CandleStore'
    | 'BackfillService'
    | 'CandleBuilder'
    | 'SessionClock'
    | 'SourceRuleRegistry'
    | 'CRTDetector'
    | 'RiskCalculator'
    | 'SignalStateMachine'
    | 'ReplayBacktester';
  stage: string;
  responsibility: string;
  status: 'STAGE_2A_FOUNDATION' | 'PLANNED_NOT_IMPLEMENTED';
}

export const PLANNED_ARCHITECTURE_MODULES: readonly PlannedModuleSpec[] = [
  {
    id: 'MarketDataAdapter',
    stage: 'Stage 2A / 2B',
    responsibility:
      'Read-only server-side market-data adapter contract (NoProviderAdapter default + allowlisted OandaV20MarketDataAdapter skeleton behind server secrets).',
    status: 'STAGE_2A_FOUNDATION',
  },
  {
    id: 'SessionClock',
    stage: 'Stage 2A',
    responsibility:
      'DST-safe America/New_York 17:00 daily roll and H4 anchor policy (17/21/01/05/09/13 NY) paired with Asia/Kolkata display clocks and canonical UTC storage.',
    status: 'STAGE_2A_FOUNDATION',
  },
  {
    id: 'CandleValidator',
    stage: 'Stage 2A',
    responsibility:
      'Auditable OHLC integrity, chronological ordering, duplicate prevention, publication grace period, and verified schedule closure validation.',
    status: 'STAGE_2A_FOUNDATION',
  },
  {
    id: 'CandleStore',
    stage: 'Stage 2A',
    responsibility:
      'Provider-neutral completed-candle repository interface with deterministic InMemoryCandleStore and optional parameterized PostgreSQL store.',
    status: 'STAGE_2A_FOUNDATION',
  },
  {
    id: 'BackfillService',
    stage: 'Stage 2A / 2B',
    responsibility:
      'Disabled-by-default bounded historical pagination (<=5000 bars/request), idempotent deduplication, source revision detection, and standalone worker interface.',
    status: 'STAGE_2A_FOUNDATION',
  },
  {
    id: 'CandleBuilder',
    stage: 'Stage 2B',
    responsibility:
      'Live incremental candle ingestion and verified provider reconciliation once authenticated Stage 2B credentials are validated.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
  {
    id: 'SourceRuleRegistry',
    stage: 'Stage 3',
    responsibility:
      'Versioned registry mapping validated CRT source research documents into explicit, auditable boolean rule definitions.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
  {
    id: 'CRTDetector',
    stage: 'Stage 3',
    responsibility:
      'Server-side structural detection of HTF range formation, sweep/manipulation, and LTF confirmation strictly from verified closed candles.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
  {
    id: 'RiskCalculator',
    stage: 'Stage 4',
    responsibility:
      'Discretionary position-sizing and invalidation-distance reference calculator (read-only analytics, never connected to broker order execution).',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
  {
    id: 'SignalStateMachine',
    stage: 'Stage 4',
    responsibility:
      'Auditable lifecycle transitions between forming, pending, confirmed, invalidated, and expired signal states with UTC timestamps.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
  {
    id: 'ReplayBacktester',
    stage: 'Stage 5',
    responsibility:
      'Historical bar-by-bar replay verification against validated rule versions (including retained M1 intrabar history) before live discretionary monitoring.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
] as const;

export const TIMEFRAME_DEFINITIONS = {
  HTF: {
    code: 'HTF',
    name: 'Higher Timeframe (D1, H4)',
    description:
      'Macro structural context anchored to 17:00 America/New_York daily roll (H4 local opens: 17:00, 21:00, 01:00, 05:00, 09:00, 13:00 NY). Never assumed as fixed UTC boundaries.',
  },
  LTF: {
    code: 'LTF',
    name: 'Lower Timeframe (H1, M15)',
    description:
      'Execution-context structure for intrarange observation once verified bars exist. M1 history is retained for future replay ordering; M5 is deferred to a later stage.',
  },
} as const;
