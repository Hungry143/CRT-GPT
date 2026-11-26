import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveConfirmedSignalCount,
  deriveMarketStatusView,
  deriveTimeframeRows,
  NO_DATA_DASH,
} from '../shared/utils/display';
import {
  formatKolkataClock,
  formatNewYorkClock,
  getTimeZoneOffsetLabel,
  getTimeZoneShortName,
  MARKET_REFERENCE_TIMEZONE,
  USER_CLOCK_TIMEZONE,
} from '../shared/utils/time';
import type { MarketFeedStatus, Signal } from '../shared/contracts/api';

test('null provider tick/bar produces no price, no inferred market bias, and zero confirmed signals', () => {
  const unconfiguredFeed: MarketFeedStatus = {
    state: 'NOT_CONFIGURED',
    provider: null,
    symbol: null,
    lastTickAtUtc: null,
    lastClosedBarAtUtc: null,
    quality: 'UNAVAILABLE',
  };

  const marketView = deriveMarketStatusView(unconfiguredFeed);
  assert.equal(marketView.isConnected, false);
  assert.equal(marketView.hasPriceData, false);
  assert.equal(marketView.providerLabel, 'Not configured');
  assert.equal(marketView.symbolLabel, NO_DATA_DASH);
  assert.equal(marketView.lastValidTickLabel, NO_DATA_DASH);
  assert.equal(marketView.lastValidCandleLabel, NO_DATA_DASH);
  assert.equal(marketView.candleQualityLabel, 'Unavailable');

  const rows = deriveTimeframeRows(unconfiguredFeed);
  assert.equal(rows.length, 5);
  const activeRows = rows.filter((r) => r.enabled);
  assert.deepEqual(
    activeRows.map((r) => r.timeframe),
    ['D1', 'H4', 'H1', 'M15']
  );
  for (const row of activeRows) {
    assert.equal(row.statusLabel, 'Awaiting feed');
    assert.equal(row.biasLabel, NO_DATA_DASH);
  }

  const m5 = rows.find((r) => r.timeframe === 'M5');
  assert.ok(m5);
  assert.equal(m5.enabled, false);
  assert.equal(m5.biasLabel, NO_DATA_DASH);

  // Even if a hypothetical confirmed signal object were passed, null tick/bar + disconnected feed forces count to 0.
  const hypotheticalSignal: Signal = {
    id: 'test-only',
    instrument: 'XAUUSD',
    state: 'confirmed',
    direction: 'LONG',
    htfTimeframe: 'H4',
    ltfTimeframe: 'M15',
    createdAtUtc: '2026-01-15T12:00:00.000Z',
    updatedAtUtc: '2026-01-15T12:00:00.000Z',
    ruleVersion: '0.0.0-test',
    evidence: [],
  };
  assert.equal(
    deriveConfirmedSignalCount(unconfiguredFeed, [hypotheticalSignal]),
    0
  );
});

test('time formatter switches America/New_York offset cleanly between winter (EST) and summer (EDT)', () => {
  // 15 Jan 2026 15:00:00 UTC -> Winter in New York (EST, UTC-05:00 -> 10:00:00)
  const winterUtc = '2026-01-15T15:00:00.000Z';
  const winterNy = formatNewYorkClock(winterUtc);
  const winterNyOffset = getTimeZoneOffsetLabel(
    winterUtc,
    MARKET_REFERENCE_TIMEZONE
  );
  const winterNyShort = getTimeZoneShortName(
    winterUtc,
    MARKET_REFERENCE_TIMEZONE
  );

  // 15 Jul 2026 15:00:00 UTC -> Summer in New York (EDT, UTC-04:00 -> 11:00:00)
  const summerUtc = '2026-07-15T15:00:00.000Z';
  const summerNy = formatNewYorkClock(summerUtc);
  const summerNyOffset = getTimeZoneOffsetLabel(
    summerUtc,
    MARKET_REFERENCE_TIMEZONE
  );
  const summerNyShort = getTimeZoneShortName(
    summerUtc,
    MARKET_REFERENCE_TIMEZONE
  );

  assert.equal(winterNyOffset, 'UTC-05:00');
  assert.equal(winterNy.timeLabel, '10:00:00');
  assert.equal(winterNyShort, 'EST');

  assert.equal(summerNyOffset, 'UTC-04:00');
  assert.equal(summerNy.timeLabel, '11:00:00');
  assert.equal(summerNyShort, 'EDT');

  assert.notEqual(winterNyOffset, summerNyOffset);

  // Asia/Kolkata does not observe DST and stays UTC+05:30 in both winter and summer
  const winterIst = formatKolkataClock(winterUtc);
  const summerIst = formatKolkataClock(summerUtc);
  assert.equal(getTimeZoneOffsetLabel(winterUtc, USER_CLOCK_TIMEZONE), 'UTC+05:30');
  assert.equal(getTimeZoneOffsetLabel(summerUtc, USER_CLOCK_TIMEZONE), 'UTC+05:30');
  assert.equal(winterIst.timeLabel, '20:30:00');
  assert.equal(summerIst.timeLabel, '20:30:00');
});
