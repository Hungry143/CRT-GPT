import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET as getMarketStatus } from '../app/api/market/status/route';
import { GET as getMarketCandles } from '../app/api/market/candles/route';
import { GET as getSystemStatus } from '../app/api/system/status/route';
import {
  MarketCandlesResponseSchema,
  MarketStatusResponseSchema,
  type NormalizedCandle,
} from '../shared/contracts/marketData';
import {
  validateCandleSeries,
  validateNormalizedCandle,
} from '../shared/utils/candleValidator';
import { computeCandleMidpoints } from '../shared/utils/sessionClock';
import {
  buildSyntheticClosedCandles,
  SYNTHETIC_FIXTURE_WATERMARK,
} from './fixtures/syntheticCandles';

test('no API credentials case: /api/market/status=NOT_CONFIGURED, /api/market/candles=[], confirmedSignals=0, CRT & signals DISABLED', async () => {
  const statusRes = await getMarketStatus();
  assert.equal(statusRes.status, 200);
  const statusJson = MarketStatusResponseSchema.parse(await statusRes.json());

  assert.equal(statusJson.adapterName, 'NoProviderAdapter');
  assert.equal(statusJson.providerVerified, false);
  assert.equal(statusJson.instrument, null);
  assert.equal(statusJson.quality.state, 'NOT_CONFIGURED');
  assert.equal(statusJson.quality.lastSuccessfulRequestUtc, null);
  assert.equal(statusJson.quality.lastCompleteCandleCloseUtc, null);
  assert.equal(statusJson.quality.freshnessSeconds, null);
  assert.equal(statusJson.quality.missingBarCount, null);
  assert.equal(statusJson.quality.duplicateBarCount, null);
  assert.equal(statusJson.historyPersistence, 'NOT_PERSISTENT');
  assert.equal(statusJson.backfillEnabled, false);
  assert.equal(statusJson.crtEngineEnabled, false);
  assert.equal(statusJson.signalsEnabled, false);
  assert.equal(statusJson.orderExecutionEnabled, false);

  const candlesReq = new NextRequest(
    'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=M15&limit=100'
  );
  const candlesRes = await getMarketCandles(candlesReq);
  assert.equal(candlesRes.status, 200);
  const candlesJson = MarketCandlesResponseSchema.parse(
    await candlesRes.json()
  );
  assert.equal(candlesJson.status, 'NOT_CONFIGURED');
  assert.deepEqual(candlesJson.data, []);
  assert.equal(candlesJson.count, 0);
  assert.equal(candlesJson.completedOnly, true);

  const sysRes = await getSystemStatus();
  const sysJson = await sysRes.json();
  assert.equal(sysJson.signalService.confirmedSignals, 0);
  assert.equal(sysJson.crtEngine.state, 'DISABLED');
  assert.equal(sysJson.signalService.state, 'DISABLED');
});

test('simulated valid closed candles serialize strictly ordered with no lookahead and separate price vs time midpoints', () => {
  assert.equal(
    SYNTHETIC_FIXTURE_WATERMARK,
    'SYNTHETIC TEST DATA — NOT LIVE / NO SIGNAL'
  );

  const candles = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 4,
    granularity: 'M15',
    retrievedAtUtc: '2026-06-15T11:15:00.000Z',
  });

  const validation = validateCandleSeries(candles, {
    nowUtc: new Date('2026-06-15T11:15:00.000Z'),
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.accepted.length, 4);
  assert.equal(validation.rejected.length, 0);
  assert.equal(validation.duplicateBarCount, 0);
  assert.equal(validation.missingBarCount, 0);

  // Verify strict chronological ordering
  for (let i = 1; i < validation.accepted.length; i++) {
    assert.ok(
      Date.parse(validation.accepted[i].openTimeUtc) >
        Date.parse(validation.accepted[i - 1].openTimeUtc)
    );
  }

  // Price 50% midpoint and elapsed-time 50% midpoint are explicitly separate values
  const midpoints = computeCandleMidpoints(validation.accepted[0]);
  assert.equal(midpoints.priceMidpoint, '2600.750');
  assert.equal(midpoints.elapsedTimeMidpointUtc, '2026-06-15T10:07:30.000Z');
  assert.notEqual(midpoints.priceMidpoint, midpoints.elapsedTimeMidpointUtc);
});

test('CandleValidator rejects malformed OHLC, non-positive prices, missing timestamp, incomplete candle, premature close, duplicates, and reversed time', () => {
  const [validBase, secondBar] = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    retrievedAtUtc: '2026-06-15T11:00:00.000Z',
  });
  const nowUtc = new Date('2026-06-15T11:00:00.000Z');

  // 1. High < open
  const badHigh: NormalizedCandle = { ...validBase, high: '2599.000' };
  const resBadHigh = validateNormalizedCandle(badHigh, { nowUtc });
  assert.equal(resBadHigh.valid, false);
  assert.ok(resBadHigh.issues.some((i) => i.code === 'OHLC_INVARIANT_VIOLATION'));

  // 2. Low > close
  const badLow: NormalizedCandle = { ...validBase, low: '2603.000' };
  const resBadLow = validateNormalizedCandle(badLow, { nowUtc });
  assert.equal(resBadLow.valid, false);
  assert.ok(resBadLow.issues.some((i) => i.code === 'OHLC_INVARIANT_VIOLATION'));

  // 3. Zero/negative price
  const badZero = { ...validBase, low: '0' };
  assert.equal(validateNormalizedCandle(badZero, { nowUtc }).valid, false);

  // 4. Missing timestamp
  const missingTs = { ...validBase, openTimeUtc: undefined };
  const resMissingTs = validateNormalizedCandle(missingTs, { nowUtc });
  assert.equal(resMissingTs.valid, false);
  assert.ok(resMissingTs.issues.some((i) => i.code === 'SCHEMA_INVALID'));

  // 5. Incomplete candle
  const incomplete: NormalizedCandle = { ...validBase, complete: false };
  const resIncomplete = validateNormalizedCandle(incomplete, { nowUtc });
  assert.equal(resIncomplete.valid, false);
  assert.ok(resIncomplete.issues.some((i) => i.code === 'INCOMPLETE_CANDLE'));

  // 6. Premature publication (within 5s grace window after closeTimeUtc 10:15:00Z)
  const resPremature = validateNormalizedCandle(validBase, {
    nowUtc: new Date('2026-06-15T10:15:02.000Z'),
  });
  assert.equal(resPremature.valid, false);
  assert.ok(resPremature.issues.some((i) => i.code === 'PREMATURE_PUBLICATION'));

  // 7. Lookahead future candle
  const resLookahead = validateNormalizedCandle(validBase, {
    nowUtc: new Date('2026-06-15T09:59:00.000Z'),
  });
  assert.equal(resLookahead.valid, false);
  assert.ok(resLookahead.issues.some((i) => i.code === 'LOOKAHEAD_TIMESTAMP'));

  // 8. Duplicate timestamp in series
  const dupSeries = validateCandleSeries([validBase, validBase], { nowUtc });
  assert.equal(dupSeries.valid, false);
  assert.equal(dupSeries.duplicateBarCount, 1);
  assert.equal(dupSeries.accepted.length, 1);

  // 9. Reversed chronological order in series
  const reversedSeries = validateCandleSeries([secondBar, validBase], { nowUtc });
  assert.equal(reversedSeries.valid, false);
  assert.ok(
    reversedSeries.issues.some((i) => i.code === 'REVERSED_SERIES_ORDER')
  );
});

test('GET /api/market/candles rejects invalid symbol, invalid timeframe (including deferred M5), and oversized/malformed limits', async () => {
  const invalidUrls = [
    'http://localhost:3000/api/market/candles?instrument=EURUSD&granularity=M15&limit=50',
    'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=M5&limit=50',
    'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=W1&limit=50',
    'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=M15&limit=501',
    'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=M15&limit=0',
    'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=M15&limit=-10',
    'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=M15&limit=abc',
  ];

  for (const url of invalidUrls) {
    const res = await getMarketCandles(new NextRequest(url));
    assert.equal(res.status, 400, `Expected HTTP 400 for ${url}`);
    const body = await res.json();
    assert.equal(body.code, 'INVALID_QUERY_PARAMETER');
  }
});
