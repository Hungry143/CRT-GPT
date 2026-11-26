/**
 * Planned architectural boundaries for post-Stage 1 milestones.
 * Stage 1 documents these contracts only — NO CRT algorithms, rule evaluators,
 * or synthetic data adapters are implemented in this milestone.
 */

export interface PlannedModuleSpec {
  id:
    | 'MarketDataAdapter'
    | 'CandleBuilder'
    | 'SessionClock'
    | 'SourceRuleRegistry'
    | 'CRTDetector'
    | 'RiskCalculator'
    | 'SignalStateMachine'
    | 'ReplayBacktester';
  stage: string;
  responsibility: string;
  status: 'PLANNED_NOT_IMPLEMENTED';
}

export const PLANNED_ARCHITECTURE_MODULES: readonly PlannedModuleSpec[] = [
  {
    id: 'MarketDataAdapter',
    stage: 'Stage 2',
    responsibility:
      'Authenticated server-side market-data ingestion for XAUUSD with connection health telemetry and strict separation from the TradingView display widget.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
  {
    id: 'CandleBuilder',
    stage: 'Stage 2',
    responsibility:
      'Deterministic aggregation of verified ticks into closed UTC OHLC bars across D1, H4, H1, and M15 with gap and staleness quality tagging.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
  {
    id: 'SessionClock',
    stage: 'Stage 2',
    responsibility:
      'DST-safe America/New_York session boundary tracking (Asia, London, New York killzones and daily open anchors) derived strictly from IANA time zones.',
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
      'Historical bar-by-bar replay verification against validated rule versions to audit precision before live discretionary monitoring.',
    status: 'PLANNED_NOT_IMPLEMENTED',
  },
] as const;

export const TIMEFRAME_DEFINITIONS = {
  HTF: {
    code: 'HTF',
    name: 'Higher Timeframe (D1, H4)',
    description:
      'Macro structural context used to identify primary candle ranges, liquidity highs/lows, and directional narrative once verified bars are available.',
  },
  LTF: {
    code: 'LTF',
    name: 'Lower Timeframe (H1, M15)',
    description:
      'Execution-context structure used to observe intrarange sweeps, displacement, and structural confirmation inside an active HTF level. M5 is reserved for future support.',
  },
} as const;
