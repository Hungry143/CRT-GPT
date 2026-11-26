import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OandaV20MarketDataAdapter,
  normalizeOandaCandles,
} from '../server/marketData/oandaV20Adapter';
import {
  InMemoryCandleStore,
  PostgresCandleStore,
  type PgQueryExecutor,
} from '../server/marketData/candleStore';
import { BackfillService } from '../server/marketData/backfillService';
import { validateCandleSeries } from '../shared/utils/candleValidator';
import { createVerifiedFxMetalSchedule } from '../shared/utils/sessionClock';
import {
  buildSyntheticClosedCandles,
  buildSyntheticOandaRawPayload,
} from './fixtures/syntheticCandles';

test('OandaV20MarketDataAdapter: missing creds -> NOT_CONFIGURED, 401 -> AUTH_ERROR, unknown instrument -> INSTRUMENT_UNAVAILABLE', async () => {
  // 1. Missing credentials
  const unconfigured = new OandaV20MarketDataAdapter(null);
  const st0 = await unconfigured.getStatus();
  assert.equal(st0.quality.state, 'NOT_CONFIGURED');
  assert.equal(st0.providerVerified, false);

  // 2. 401 auth error redacts secret token & account ID
  const secretToken = 'oanda-super-secret-token-999888';
  const accountId = '101-001-1234567-001';
  const authFailAdapter = new OandaV20MarketDataAdapter(
    {
      env: 'practice',
      accountId,
      apiToken: secretToken,
      instrument: 'XAU_USD',
      maxRetries: 0,
    },
    {
      fetchFn: async () =>
        new Response(JSON.stringify({ errorMessage: 'Invalid token' }), {
          status: 401,
        }),
    }
  );
  const authRes = await authFailAdapter.verifyInstrument();
  assert.equal(authRes.verified, false);
  assert.equal(authRes.state, 'AUTH_ERROR');
  const authStatus = await authFailAdapter.getStatus();
  assert.equal(JSON.stringify(authStatus).includes(secretToken), false);
  assert.equal(JSON.stringify(authStatus).includes(accountId), false);

  // 3. Account does not list XAU_USD -> INSTRUMENT_UNAVAILABLE
  const unavailableAdapter = new OandaV20MarketDataAdapter(
    {
      env: 'practice',
      accountId,
      apiToken: secretToken,
      instrument: 'XAU_USD',
      maxRetries: 0,
    },
    {
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            instruments: [{ name: 'EUR_USD', displayPrecision: 5, pipLocation: -4 }],
          }),
          { status: 200 }
        ),
    }
  );
  const unavailRes = await unavailableAdapter.verifyInstrument();
  assert.equal(unavailRes.verified, false);
  assert.equal(unavailRes.state, 'INSTRUMENT_UNAVAILABLE');
});

test('OandaV20MarketDataAdapter retries on 429/503 with bounded backoff and handles feed outage without fabricating bars', async () => {
  const observedUrls: string[] = [];
  let candleCalls = 0;

  const syntheticBars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-15T11:00:00.000Z',
  });

  const adapter = new OandaV20MarketDataAdapter(
    {
      env: 'practice',
      accountId: '101-001-5555555-001',
      apiToken: 'test-token-value-1234',
      instrument: 'XAU_USD',
      maxRetries: 2,
      baseRetryDelayMs: 1,
    },
    {
      sleepFn: async () => {},
      randomFn: () => 0.1,
      nowFn: () => new Date('2026-06-15T11:00:00.000Z'),
      fetchFn: async (input) => {
        const url = String(input);
        observedUrls.push(url);

        if (url.includes('/instruments?')) {
          return new Response(
            JSON.stringify({
              instruments: [
                { name: 'XAU_USD', displayPrecision: 3, pipLocation: -2 },
              ],
            }),
            { status: 200 }
          );
        }

        candleCalls += 1;
        // First attempt returns 429, second returns 503, third succeeds
        if (candleCalls === 1) {
          return new Response('rate limited', { status: 429 });
        }
        if (candleCalls === 2) {
          return new Response('upstream error', { status: 503 });
        }
        if (candleCalls === 3) {
          return new Response(
            JSON.stringify(buildSyntheticOandaRawPayload(syntheticBars, 'M15')),
            { status: 200 }
          );
        }
        // Subsequent outage returns 503 continuously
        return new Response('outage', { status: 503 });
      },
    }
  );

  // First fetch succeeds after 2 retries and uses allowlisted query params
  const first = await adapter.fetchCompletedCandles({
    granularity: 'M15',
    limit: 2,
  });
  assert.equal(first.status, 'CONNECTED');
  assert.equal(first.candles.length, 2);
  assert.equal(candleCalls, 3);

  const candlesUrl = observedUrls.find((u) => u.includes('/candles'));
  assert.ok(candlesUrl);
  assert.ok(candlesUrl.startsWith('https://api-fxpractice.oanda.com/v3/instruments/XAU_USD/candles'));
  assert.ok(candlesUrl.includes('smooth=false'));
  assert.ok(candlesUrl.includes('price=M'));
  assert.ok(candlesUrl.includes('dailyAlignment=17'));
  assert.ok(candlesUrl.includes('alignmentTimezone=America%2FNew_York'));

  // Subsequent outage transitions to STALE and returns ZERO fabricated bars
  const outage = await adapter.fetchCompletedCandles({
    granularity: 'M15',
    limit: 2,
  });
  assert.equal(outage.status, 'STALE');
  assert.deepEqual(outage.candles, []);
  const statusAfterOutage = await adapter.getStatus();
  assert.equal(statusAfterOutage.quality.state, 'STALE');
});

test('normalizeOandaCandles strips incomplete bars and preserves provider-neutral normalized schema', () => {
  const closed = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
  });
  const raw = buildSyntheticOandaRawPayload(closed, 'M15');
  raw.candles[1].complete = false;

  const res = normalizeOandaCandles(raw, {
    granularity: 'M15',
    retrievedAtUtc: '2026-06-15T11:00:00.000Z',
    nowUtc: new Date('2026-06-15T11:00:00.000Z'),
  });

  assert.equal(res.accepted.length, 1);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.accepted[0].provider, 'oanda_v20');
  assert.equal(res.accepted[0].complete, true);
});

test('BackfillService is disabled by default, paginates without dropping/duplicating boundary candles, replays idempotently, and detects revisions', async () => {
  const allBars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 5,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-15T13:00:00.000Z',
  });

  let serveRevised = false;
  const mockAdapter = {
    adapterName: 'MockPaginatedAdapter',
    alignmentPolicy: new OandaV20MarketDataAdapter(null).alignmentPolicy,
    getStatus: async () => (await new OandaV20MarketDataAdapter(null).getStatus()),
    verifyInstrument: async () => ({
      verified: true,
      state: 'CONNECTED' as const,
      instrument: null,
      reasonCode: null,
    }),
    fetchCompletedCandles: async (req: {
      limit: number;
      fromUtc?: string;
      includeFirst?: boolean;
    }) => {
      const fromMs = req.fromUtc ? Date.parse(req.fromUtc) : 0;
      const filtered = allBars
        .filter((b) =>
          req.includeFirst === false
            ? Date.parse(b.openTimeUtc) > fromMs
            : Date.parse(b.openTimeUtc) >= fromMs
        )
        .slice(0, req.limit)
        .map((b, idx) =>
          serveRevised && b.openTimeUtc === allBars[2].openTimeUtc && idx >= 0
            ? { ...b, close: '2606.999', high: '2610.000' }
            : b
        );
      return {
        status: 'CONNECTED' as const,
        candles: filtered,
        retrievedAtUtc: '2026-06-15T13:00:00.000Z',
        duplicateBarCount: 0,
        missingBarCount: 0,
        warnings: [],
        reasonCode: null,
      };
    },
  };

  const store = new InMemoryCandleStore();
  assert.equal(store.getPersistenceState(), 'NOT_PERSISTENT');

  // 1. Disabled by default
  const disabledBackfill = new BackfillService({ adapter: mockAdapter, store });
  const disabledRun = await disabledBackfill.scheduleOnce({
    granularity: 'M15',
    fromUtc: '2026-06-15T10:00:00.000Z',
    toUtc: '2026-06-15T12:00:00.000Z',
    batchSize: 2,
  });
  assert.equal(disabledRun.status, 'DISABLED');

  // 2. Enabled bounded pagination (batchSize=2 across 5 bars -> 3 pages, zero lost/duplicated boundaries)
  const enabledBackfill = new BackfillService({
    adapter: mockAdapter,
    store,
    enabled: true,
    nowFn: () => new Date('2026-06-15T13:00:00.000Z'),
  });
  const firstRun = await enabledBackfill.scheduleOnce({
    granularity: 'M15',
    fromUtc: '2026-06-15T10:00:00.000Z',
    toUtc: '2026-06-15T12:00:00.000Z',
    batchSize: 2,
  });
  assert.equal(firstRun.status, 'COMPLETED');
  assert.equal(firstRun.insertedCount, 5);
  assert.equal(firstRun.unchangedCount, 0);
  assert.equal(firstRun.pagesFetched, 3);

  const stored = await store.getCompletedCandles({ granularity: 'M15', limit: 20 });
  assert.equal(stored.length, 5);

  // 3. Idempotent replay inserts 0 new bars
  const replayRun = await enabledBackfill.scheduleOnce({
    granularity: 'M15',
    fromUtc: '2026-06-15T10:00:00.000Z',
    toUtc: '2026-06-15T12:00:00.000Z',
    batchSize: 2,
  });
  assert.equal(replayRun.insertedCount, 0);
  assert.equal(replayRun.unchangedCount, 5);
  assert.equal(replayRun.revisionsDetected.length, 0);

  // 4. Unexpected historical change is flagged as a source revision
  serveRevised = true;
  const revisionRun = await enabledBackfill.scheduleOnce({
    granularity: 'M15',
    fromUtc: '2026-06-15T10:00:00.000Z',
    toUtc: '2026-06-15T12:00:00.000Z',
    batchSize: 2,
  });
  assert.equal(revisionRun.revisionsDetected.length, 1);
  assert.ok(revisionRun.revisionsDetected[0].changedFields.includes('close'));
});

test('weekend/holiday gaps are treated as expected closures ONLY when a verified schedule confirms them', () => {
  // Fri 2026-06-19 16:00 EDT (20:00Z -> closes 21:00Z = Fri 17:00 EDT) to Sun 2026-06-21 17:00 EDT (21:00Z)
  const fridayLastH1 = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-19T20:00:00.000Z',
    count: 1,
    granularity: 'H1',
    retrievedAtUtc: '2026-06-22T01:00:00.000Z',
  })[0];
  const sundayOpenH1 = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-21T21:00:00.000Z',
    count: 1,
    granularity: 'H1',
    retrievedAtUtc: '2026-06-22T01:00:00.000Z',
  })[0];

  const nowUtc = new Date('2026-06-22T01:00:00.000Z');

  // Without verified schedule -> gap is flagged (NOT silently dismissed)
  const withoutSchedule = validateCandleSeries([fridayLastH1, sundayOpenH1], {
    nowUtc,
    verifiedSchedule: null,
  });
  assert.equal(withoutSchedule.missingBarCount, 48);
  assert.equal(withoutSchedule.expectedClosureGapCount, 0);

  // With verified FX/metals schedule -> 48h weekend gap recognized as expected closure, 0 false alerts
  const verifiedSchedule = createVerifiedFxMetalSchedule(['2026-12-25']);
  const withSchedule = validateCandleSeries([fridayLastH1, sundayOpenH1], {
    nowUtc,
    verifiedSchedule,
  });
  assert.equal(withSchedule.missingBarCount, 0);
  assert.equal(withSchedule.expectedClosureGapCount, 48);
  assert.equal(withSchedule.valid, true);
});

test('PostgresCandleStore reports NOT_PERSISTENT without DATABASE_URL and uses strictly parameterized SQL when configured', async () => {
  const unconfiguredPg = new PostgresCandleStore({ databaseUrl: '' });
  assert.equal(unconfiguredPg.getPersistenceState(), 'NOT_PERSISTENT');

  const recordedQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const fakeExecutor: PgQueryExecutor = {
    async query(sql, params) {
      recordedQueries.push({ sql, params });
      return { rows: [] };
    },
  };

  const configuredPg = new PostgresCandleStore({
    databaseUrl: 'postgres://user:pass@localhost:5432/crt_test',
    executor: fakeExecutor,
  });
  assert.equal(configuredPg.getPersistenceState(), 'POSTGRES_CONNECTED');

  const [bar] = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 1,
    granularity: 'M15',
  });
  await configuredPg.upsertCandles([bar]);

  assert.equal(recordedQueries.length, 2);
  assert.ok(recordedQueries[0].sql.includes('$1'));
  assert.ok(recordedQueries[1].sql.includes('$14'));
  assert.equal(recordedQueries[1].sql.includes(bar.sourceCandleId), false);
});
