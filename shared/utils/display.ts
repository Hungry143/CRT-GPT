import type {
  EngineState,
  FeedState,
  MarketFeedStatus,
  Signal,
  SignalServiceState,
  TimeframeCode,
} from '@/shared/contracts/api';
import { formatNewYorkClock, toUtcIsoString } from '@/shared/utils/time';

export const NO_DATA_DASH = '—' as const;

export interface TimeframeRowViewModel {
  timeframe: TimeframeCode;
  role: 'HTF' | 'LTF' | 'FUTURE';
  enabled: boolean;
  statusLabel: string;
  biasLabel: string;
  lastClosedBarLabel: string;
}

export interface MarketStatusViewModel {
  isConnected: boolean;
  feedStateLabel: string;
  providerLabel: string;
  symbolLabel: string;
  lastValidTickLabel: string;
  lastValidCandleLabel: string;
  candleQualityLabel: string;
  hasPriceData: boolean;
}

export function formatFeedStateLabel(state: FeedState): string {
  switch (state) {
    case 'NOT_CONFIGURED':
      return 'Not configured';
    case 'DISCONNECTED':
      return 'Not connected';
    case 'CONNECTING':
      return 'Connecting';
    case 'DEGRADED':
      return 'Degraded';
    case 'CONNECTED':
      return 'Connected';
  }
}

export function formatEngineStateLabel(state: EngineState): string {
  switch (state) {
    case 'DISABLED':
      return 'Disabled';
    case 'AWAITING_FEED':
      return 'Awaiting feed';
    case 'IDLE':
      return 'Idle';
    case 'RUNNING':
      return 'Running';
    case 'ERROR':
      return 'Error';
  }
}

export function formatSignalServiceStateLabel(
  state: SignalServiceState
): string {
  switch (state) {
    case 'DISABLED':
      return 'Disabled';
    case 'ACTIVE':
      return 'Active';
    case 'PAUSED':
      return 'Paused';
    case 'ERROR':
      return 'Error';
  }
}

/**
 * Pure presentation mapper for Market Status.
 * Enforces Stage 1 data-integrity rule: null provider/tick/bar produces
 * explicit unconfigured labels (`Not configured` / `—`), never an invented quote or market-open claim.
 */
export function deriveMarketStatusView(
  marketFeed: MarketFeedStatus
): MarketStatusViewModel {
  const hasTick = marketFeed.lastTickAtUtc !== null;
  const hasBar = marketFeed.lastClosedBarAtUtc !== null;
  const isConnected = marketFeed.state === 'CONNECTED';

  return {
    isConnected,
    feedStateLabel: formatFeedStateLabel(marketFeed.state),
    providerLabel: marketFeed.provider ?? 'Not configured',
    symbolLabel: marketFeed.symbol ?? NO_DATA_DASH,
    lastValidTickLabel:
      marketFeed.lastTickAtUtc !== null
        ? `${toUtcIsoString(marketFeed.lastTickAtUtc)} (${formatNewYorkClock(marketFeed.lastTickAtUtc).timeLabel} NY)`
        : NO_DATA_DASH,
    lastValidCandleLabel:
      marketFeed.lastClosedBarAtUtc !== null
        ? `${toUtcIsoString(marketFeed.lastClosedBarAtUtc)} (${formatNewYorkClock(marketFeed.lastClosedBarAtUtc).timeLabel} NY)`
        : NO_DATA_DASH,
    candleQualityLabel:
      marketFeed.quality === 'UNAVAILABLE'
        ? 'Unavailable'
        : marketFeed.quality.charAt(0) +
          marketFeed.quality.slice(1).toLowerCase(),
    hasPriceData: isConnected && (hasTick || hasBar),
  };
}

/**
 * Pure presentation mapper for the Stage 1 timeframe table.
 * When `lastClosedBarAtUtc` is null or feed is not connected, all active timeframes
 * report `Awaiting feed` and bias is strictly `—` (never inferred).
 */
export function deriveTimeframeRows(
  marketFeed: MarketFeedStatus
): TimeframeRowViewModel[] {
  const feedReady =
    marketFeed.state === 'CONNECTED' && marketFeed.lastClosedBarAtUtc !== null;

  const activeRows: Array<{ timeframe: TimeframeCode; role: 'HTF' | 'LTF' }> = [
    { timeframe: 'D1', role: 'HTF' },
    { timeframe: 'H4', role: 'HTF' },
    { timeframe: 'H1', role: 'LTF' },
    { timeframe: 'M15', role: 'LTF' },
  ];

  const rows: TimeframeRowViewModel[] = activeRows.map(({ timeframe, role }) => ({
    timeframe,
    role,
    enabled: true,
    statusLabel: feedReady ? 'Feed connected' : 'Awaiting feed',
    biasLabel: NO_DATA_DASH,
    lastClosedBarLabel: NO_DATA_DASH,
  }));

  rows.push({
    timeframe: 'M5',
    role: 'FUTURE',
    enabled: false,
    statusLabel: 'Future support (disabled)',
    biasLabel: NO_DATA_DASH,
    lastClosedBarLabel: NO_DATA_DASH,
  });

  return rows;
}

/**
 * Counts confirmed signals strictly from verified payload data.
 * If feed is not connected or tick/bar are null, confirmed display count is guaranteed 0.
 */
export function deriveConfirmedSignalCount(
  marketFeed: MarketFeedStatus,
  signals: Signal[]
): number {
  if (
    marketFeed.state !== 'CONNECTED' ||
    (marketFeed.lastTickAtUtc === null && marketFeed.lastClosedBarAtUtc === null)
  ) {
    return 0;
  }
  return signals.filter((s) => s.state === 'confirmed').length;
}
