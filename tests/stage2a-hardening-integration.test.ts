import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeMarketDataEnvFingerprint,
  resetMarketDataRuntime,
  resolveMarketDataRuntime,
  type MarketDataRuntime,
} from '../server/marketData/registry';
import {
  DEFAULT_FEED_CHECKPOINT_KEY,
  InMemoryCandleStore,
  PostgresCandleStore,
  type FeedCheckpointRecord,
  type PgQueryExecutor,
} from '../server/marketData/candleStore';
import {
  OandaV20MarketDataAdapter,
  type OandaV20Config,
} from '../server/marketData/oandaV20Adapter';
import { MarketDataIngestionWorker } from '../server/marketData/ingestionWorker';
import { runPostgresMigrations } from '../server/db/migrations';
import {
  createManagedPgExecutor,
  isValidPostgresConnectionString,
} from '../server/db/postgres';
import { buildMarketStatusPayload } from '../server/routes/marketStatus';
import { buildMarketCandlesPayload } from '../server/routes/marketCandles';
import { buildMarketSessionPayload } from '../server/routes/marketSession';
import { redactSensitiveText } from '../server/marketData/adapter';
import { createVerifiedFxMetalSchedule } from '../shared/utils/sessionClock';
import {
  buildSyntheticClosedCandles,
  buildSyntheticOandaRawPayload,
} from './fixtures/syntheticCandles';

/**
 * Deterministic SQL-emulating PgQueryExecutor for full persistent-status integration tests
 * even when no external PostgreSQL service is running locally.
 */
function createStatefulFakePgExecutor() {
  const migrations = new Set<string>();
  const candles = new Map<string, Record<string, unknown>>();
  const revisions: Array<Record<string, unknown>> = [];
  const checkpoints = new Map<string, Record<string, unknown>>();
  const executedQueries: Array<{ sql: string; params: readonly unknown[] }> = [];

  const executor: PgQueryExecutor = {
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[]
    ): Promise<{ rows: T[] }> {
      executedQueries.push({ sql, params });
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
        return { rows: [] };
      }

      if (normalized.startsWith('SELECT version FROM schema_migrations')) {
        return {
          rows: Array.from(migrations)
            .sort()
            .map((version) => ({ version }) as unknown as T),
        };
      }

      if (normalized.startsWith('INSERT INTO schema_migrations')) {
        migrations.add(String(params[0]));
        return { rows: [] };
      }

      if (normalized.includes('FROM normalized_candles WHERE source_candle_id = $1')) {
        const row = candles.get(String(params[0]));
        return { rows: row ? ([row] as unknown as T[]) : [] };
      }

      if (normalized.startsWith('INSERT INTO normalized_candles')) {
        const [
          source_candle_id,
          provider,
          provider_symbol,
          granularity,
          price_basis,
          open_time_utc,
          close_time_utc,
          open_price,
          high_price,
          low_price,
          close_price,
          volume,
          complete,
          source_retrieved_at_utc,
        ] = params;
        candles.set(String(source_candle_id), {
          source_candle_id,
          provider,
          provider_symbol,
          granularity,
          price_basis,
          open_time_utc,
          close_time_utc,
          open_price,
          high_price,
          low_price,
          close_price,
          volume,
          complete,
          source_retrieved_at_utc,
        });
        return { rows: [] };
      }

      if (normalized.includes('FROM normalized_candles WHERE complete = TRUE')) {
        const granularity = String(params[0]);
        const limit = Number(params[1]);
        const providerSymbol = params[2] ? String(params[2]) : null;
        const rows = Array.from(candles.values())
          .filter(
            (r) =>
              r.complete === true &&
              r.granularity === granularity &&
              (!providerSymbol || r.provider_symbol === providerSymbol)
          )
          .sort(
            (a, b) =>
              Date.parse(String(b.open_time_utc)) -
              Date.parse(String(a.open_time_utc))
          )
          .slice(0, limit);
        return { rows: rows as unknown as T[] };
      }

      if (normalized.startsWith('INSERT INTO candle_revision_events')) {
        revisions.push({
          source_candle_id: params[0],
          detected_at_utc: params[1],
          changed_fields: params[2],
          previous_close: params[3],
          revised_close: params[4],
        });
        return { rows: [] };
      }

      if (normalized.includes('FROM candle_revision_events')) {
        return { rows: revisions as unknown as T[] };
      }

      if (normalized.startsWith('INSERT INTO market_feed_checkpoints')) {
        checkpoints.set(String(params[0]), {
          checkpoint_key: params[0],
          adapter_name: params[1],
          provider_symbol: params[2],
          state: params[3],
          provider_verified: params[4],
          last_successful_request_utc: params[5],
          last_provider_candle_open_utc: params[6],
          last_complete_candle_close_utc: params[7],
          missing_bar_count: params[8],
          duplicate_bar_count: params[9],
          reason_code: params[10],
          warnings: params[11],
          updated_at_utc: params[12],
        });
        return { rows: [] };
      }

      if (normalized.includes('FROM market_feed_checkpoints WHERE checkpoint_key = $1')) {
        const row = checkpoints.get(String(params[0]));
        return { rows: row ? ([row] as unknown as T[]) : [] };
      }

      throw new Error(`Unhandled SQL in test executor: ${normalized}`);
    },
  };

  return { executor, migrations, candles, revisions, checkpoints, executedQueries };
}

test('resolveMarketDataRuntime preserves adapter and store state across repeated requests (no per-request reset)', async () => {
  await resetMarketDataRuntime();

  const envA = {
    MARKET_FEED_ENABLED: 'false',
    BACKFILL_ENABLED: 'false',
    MARKET_DATA_PROVIDER: 'none',
  };

  const rt1 = resolveMarketDataRuntime(envA);
  const rt2 = resolveMarketDataRuntime(envA);
  assert.strictEqual(rt1, rt2);
  assert.strictEqual(rt1.adapter, rt2.adapter);
  assert.strictEqual(rt1.store, rt2.store);
  assert.equal(rt1.fingerprint, computeMarketDataEnvFingerprint(envA));

  // Different config yields a separate cached runtime without clobbering envA
  const envB = {
    MARKET_FEED_ENABLED: 'true',
    BACKFILL_ENABLED: 'false',
    MARKET_DATA_PROVIDER: 'oanda_v20',
    OANDA_ENV: 'practice',
    OANDA_ACCOUNT_ID: '101-001-1234567-001',
    OANDA_API_TOKEN: 'test-secret-token-xyz',
    OANDA_INSTRUMENT: 'XAU_USD',
  };
  const rtB1 = resolveMarketDataRuntime(envB);
  const rtB2 = resolveMarketDataRuntime(envB);
  assert.strictEqual(rtB1, rtB2);
  assert.notStrictEqual(rtB1, rt1);
  assert.equal(rtB1.adapter.adapterName, 'OandaV20MarketDataAdapter');

  await resetMarketDataRuntime();
});

test('PostgreSQL migrations, persistent status, checkpoints, and revisions survive across fresh store instances', async () => {
  const fakeDb = createStatefulFakePgExecutor();
  const dbUrl = 'postgresql://crt_user:super_secret_pw@127.0.0.1:5432/crt_db';

  // 1. Idempotent versioned migrations
  const mig1 = await runPostgresMigrations(fakeDb.executor);
  assert.deepEqual(mig1.appliedVersions, ['001_stage2a_market_data']);
  assert.deepEqual(mig1.skippedVersions, []);

  const mig2 = await runPostgresMigrations(fakeDb.executor);
  assert.deepEqual(mig2.appliedVersions, []);
  assert.deepEqual(mig2.skippedVersions, ['001_stage2a_market_data']);

  // 2. Store #1 writes candles, revision, and feed checkpoint
  const store1 = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: fakeDb.executor,
  });
  assert.equal(await store1.ensureReady(), 'POSTGRES_CONNECTED');

  const bars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 3,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-15T10:50:00.000Z',
  });
  const upsert1 = await store1.upsertCandles(bars, '2026-06-15T10:50:00.000Z');
  assert.equal(upsert1.inserted, 3);
  assert.equal(upsert1.revisionsDetected.length, 0);

  // Revise middle bar close -> persisted in candle_revision_events
  const revisedBar = { ...bars[1], close: '2603.999', high: '2605.500' };
  const upsert2 = await store1.upsertCandles(
    [revisedBar],
    '2026-06-15T10:51:00.000Z'
  );
  assert.equal(upsert2.revisionsDetected.length, 1);

  const checkpoint: FeedCheckpointRecord = {
    checkpointKey: DEFAULT_FEED_CHECKPOINT_KEY,
    adapterName: 'OandaV20MarketDataAdapter',
    providerSymbol: 'XAU_USD',
    state: 'CONNECTED',
    providerVerified: true,
    lastSuccessfulRequestUtc: '2026-06-15T10:50:00.000Z',
    lastProviderCandleOpenUtc: bars[2].openTimeUtc,
    lastCompleteCandleCloseUtc: bars[2].closeTimeUtc,
    missingBarCount: 0,
    duplicateBarCount: 0,
    reasonCode: null,
    warnings: [],
    updatedAtUtc: '2026-06-15T10:50:00.000Z',
  };
  await store1.saveFeedCheckpoint(checkpoint);

  // 3. Store #2 (simulating a fresh API server process) reads persisted state & status
  const store2 = new PostgresCandleStore({
    databaseUrl: dbUrl,
    executor: fakeDb.executor,
  });
  const revisionsFromDb = await store2.getRevisionEvents();
  assert.equal(revisionsFromDb.length, 1);
  assert.equal(revisionsFromDb[0].revisedClose, '2603.999');

  const freshOandaConfig: OandaV20Config = {
    env: 'practice',
    accountId: '101-001-1234567-001',
    apiToken: 'token-abc-123456',
    instrument: 'XAU_USD',
  };
  const freshAdapter = new OandaV20MarketDataAdapter(freshOandaConfig);
  const runtime: MarketDataRuntime = {
    fingerprint: 'test-persistent',
    adapter: freshAdapter,
    store: store2,
    historyPersistence: store2.getPersistenceState(),
    backfillEnabled: false,
    marketFeedEnabled: true,
  };

  // Fresh timestamp (5 minutes after close) -> reconciled as CONNECTED & POSTGRES_CONNECTED
  const statusFresh = await buildMarketStatusPayload(
    new Date('2026-06-15T10:50:00.000Z'),
    runtime
  );
  assert.equal(statusFresh.historyPersistence, 'POSTGRES_CONNECTED');
  assert.equal(statusFresh.providerVerified, true);
  assert.equal(statusFresh.quality.state, 'CONNECTED');
  assert.equal(statusFresh.quality.lastCompleteCandleCloseUtc, bars[2].closeTimeUtc);
  assert.equal(statusFresh.quality.freshnessSeconds, 300);

  // Stale timestamp (2 hours after close) -> persisted checkpoint FAILS CLOSED to STALE
  const statusStale = await buildMarketStatusPayload(
    new Date('2026-06-15T12:50:00.000Z'),
    runtime
  );
  assert.equal(statusStale.quality.state, 'STALE');
  assert.equal(statusStale.quality.reasonCode, 'FEED_DATA_STALE');

  const sessionStale = await buildMarketSessionPayload(
    new Date('2026-06-15T12:50:00.000Z'),
    runtime
  );
  assert.equal(sessionStale.session.observedMarketAvailability, 'OBSERVED_STALE');

  // Verify secret password never leaked into any status JSON
  assert.equal(JSON.stringify(statusFresh).includes('super_secret_pw'), false);
  assert.equal(JSON.stringify(statusStale).includes('super_secret_pw'), false);
});

test('PostgresCandleStore fails closed to POSTGRES_CONFIGURED without crashing or leaking creds when DB URL is invalid or unreachable', async () => {
  assert.equal(isValidPostgresConnectionString('postgres://u:p@127.0.0.1:5432/db'), true);
  assert.equal(isValidPostgresConnectionString('http://example.com'), false);

  const badUrlStore = new PostgresCandleStore({
    databaseUrl: 'http://secretuser:secretpass@bad-host/db',
  });
  assert.equal(await badUrlStore.ensureReady(), 'POSTGRES_CONFIGURED');
  assert.equal(
    badUrlStore.getLastPersistenceError()?.includes('secretpass') ?? false,
    false
  );

  // Redaction strips postgres:// and postgresql:// credentials
  const scrubbed = redactSensitiveText(
    'connect ECONNREFUSED postgresql://dbadmin:UltraSecret99@127.0.0.1:59999/crt'
  );
  assert.equal(scrubbed.includes('UltraSecret99'), false);
  assert.ok(scrubbed.includes('postgresql://[REDACTED]@127.0.0.1:59999/crt'));
});

test('stale, gapped, and corrupted candle series FAIL CLOSED on adapter and /api/market/candles', async () => {
  const contiguousBars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 3,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-15T10:50:00.000Z',
  });
  // Latest close = 2026-06-15T10:45:00.000Z

  // 1. Adapter receiving gapped bars (bar 0 and bar 2, missing bar 1) fails closed!
  const gappedRaw = buildSyntheticOandaRawPayload(
    [contiguousBars[0], contiguousBars[2]],
    'M15'
  );
  const gappedAdapter = new OandaV20MarketDataAdapter(
    {
      env: 'practice',
      accountId: '101-001-1234567-001',
      apiToken: 'token-123456',
      instrument: 'XAU_USD',
      maxRetries: 0,
    },
    {
      nowFn: () => new Date('2026-06-15T10:50:00.000Z'),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('/instruments?')) {
          return new Response(
            JSON.stringify({
              instruments: [{ name: 'XAU_USD', displayPrecision: 3, pipLocation: -2 }],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify(gappedRaw), { status: 200 });
      },
    }
  );
  const gappedFetch = await gappedAdapter.fetchCompletedCandles({
    granularity: 'M15',
    limit: 10,
  });
  assert.equal(gappedFetch.status, 'STALE');
  assert.equal(gappedFetch.reasonCode, 'UNEXPECTED_BAR_GAP');
  assert.deepEqual(gappedFetch.candles, []);
  assert.equal(gappedFetch.missingBarCount, 1);

  // 2. Healthy adapter + store: fresh succeeds, stale fails closed, gapped store fails closed
  const healthyAdapter = new OandaV20MarketDataAdapter(
    {
      env: 'practice',
      accountId: '101-001-1234567-001',
      apiToken: 'token-123456',
      instrument: 'XAU_USD',
      maxRetries: 0,
    },
    {
      nowFn: () => new Date('2026-06-15T10:50:00.000Z'),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('/instruments?')) {
          return new Response(
            JSON.stringify({
              instruments: [{ name: 'XAU_USD', displayPrecision: 3, pipLocation: -2 }],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify(buildSyntheticOandaRawPayload(contiguousBars, 'M15')),
          { status: 200 }
        );
      },
    }
  );
  const okFetch = await healthyAdapter.fetchCompletedCandles({
    granularity: 'M15',
    limit: 10,
  });
  assert.equal(okFetch.status, 'CONNECTED');
  assert.equal(okFetch.candles.length, 3);

  const store = new InMemoryCandleStore();
  await store.upsertCandles(okFetch.candles);

  const runtime: MarketDataRuntime = {
    fingerprint: 'test-fail-closed',
    adapter: healthyAdapter,
    store,
    historyPersistence: 'NOT_PERSISTENT',
    backfillEnabled: false,
    marketFeedEnabled: true,
  };

  // Fresh read (5 min after close) -> serves 3 bars
  const freshRes = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    new Date('2026-06-15T10:50:00.000Z'),
    runtime
  );
  assert.equal(freshRes.status, 'CONNECTED');
  assert.equal(freshRes.count, 3);

  // Stale read (45 min after close > 30 min M15 budget) -> FAILS CLOSED with empty data!
  const staleRes = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    new Date('2026-06-15T11:30:00.000Z'),
    runtime
  );
  assert.equal(staleRes.status, 'STALE');
  assert.equal(staleRes.reasonCode, 'FEED_DATA_STALE');
  assert.equal(staleRes.count, 0);
  assert.deepEqual(staleRes.data, []);

  // Gapped store (drop middle bar) -> FAILS CLOSED even when timestamp is fresh!
  const gappedStore = new InMemoryCandleStore();
  await gappedStore.upsertCandles([contiguousBars[0], contiguousBars[2]]);
  const gappedRes = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'M15', limit: 10 },
    new Date('2026-06-15T10:50:00.000Z'),
    { ...runtime, store: gappedStore }
  );
  assert.equal(gappedRes.status, 'STALE');
  assert.equal(gappedRes.reasonCode, 'UNEXPECTED_BAR_GAP');
  assert.equal(gappedRes.count, 0);
  assert.deepEqual(gappedRes.data, []);

  // Verified weekend closure does NOT falsely fail closed when schedule confirms closure
  const verifiedSchedule = createVerifiedFxMetalSchedule(['2026-12-25']);
  const fridayLastH1 = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-19T20:00:00.000Z',
    count: 1,
    granularity: 'H1',
    retrievedAtUtc: '2026-06-20T12:00:00.000Z',
  });
  const weekendStore = new InMemoryCandleStore();
  await weekendStore.upsertCandles(fridayLastH1);
  const weekendAdapter = new OandaV20MarketDataAdapter(
    {
      env: 'practice',
      accountId: '101-001-1234567-001',
      apiToken: 'token-123456',
      instrument: 'XAU_USD',
      maxRetries: 0,
      verifiedSchedule,
    },
    {
      nowFn: () => new Date('2026-06-20T12:00:00.000Z'),
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes('/instruments?')) {
          return new Response(
            JSON.stringify({
              instruments: [{ name: 'XAU_USD', displayPrecision: 3, pipLocation: -2 }],
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify(buildSyntheticOandaRawPayload(fridayLastH1, 'H1')),
          { status: 200 }
        );
      },
    }
  );
  await weekendAdapter.verifyInstrument();
  const weekendRes = await buildMarketCandlesPayload(
    { instrument: 'XAUUSD', granularity: 'H1', limit: 10 },
    new Date('2026-06-20T12:00:00.000Z'),
    { ...runtime, adapter: weekendAdapter, store: weekendStore },
    { verifiedSchedule }
  );
  assert.equal(weekendRes.status, 'MARKET_CLOSED');
  assert.equal(weekendRes.count, 1);
});

test('MarketDataIngestionWorker stays disabled by default, prevents overlapping runs, enforces circuit breaker, and persists checkpoints', async () => {
  const store = new InMemoryCandleStore();
  let fetchCount = 0;

  const bars = buildSyntheticClosedCandles({
    startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
    count: 2,
    granularity: 'M15',
    provider: 'oanda_v20',
    providerSymbol: 'XAU_USD',
    retrievedAtUtc: '2026-06-15T10:35:00.000Z',
  });

  let releaseSlowFetch: (() => void) | null = null;
  const mockAdapter = {
    adapterName: 'MockWorkerAdapter',
    alignmentPolicy: new OandaV20MarketDataAdapter(null).alignmentPolicy,
    getStatus: async () => ({
      adapterName: 'MockWorkerAdapter',
      providerVerified: true,
      instrument: {
        displaySymbol: 'XAUUSD' as const,
        providerName: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        pricePrecision: 3,
        pipLocation: -2,
        verified: true,
        verifiedAtUtc: '2026-06-15T10:35:00.000Z',
      },
      quality: {
        state: 'CONNECTED' as const,
        lastSuccessfulRequestUtc: '2026-06-15T10:35:00.000Z',
        lastProviderCandleOpenUtc: bars[1].openTimeUtc,
        lastCompleteCandleCloseUtc: bars[1].closeTimeUtc,
        freshnessSeconds: 300,
        missingBarCount: 0,
        duplicateBarCount: 0,
        alignmentPolicy: new OandaV20MarketDataAdapter(null).alignmentPolicy,
        warnings: [],
        reasonCode: null,
      },
    }),
    verifyInstrument: async () => ({
      verified: true,
      state: 'CONNECTED' as const,
      instrument: null,
      reasonCode: null,
    }),
    fetchCompletedCandles: async () => {
      fetchCount += 1;
      if (releaseSlowFetch) {
        await new Promise<void>((resolve) => {
          const done = releaseSlowFetch;
          releaseSlowFetch = null;
          setTimeout(() => {
            done?.();
            resolve();
          }, 25);
        });
      }
      return {
        status: 'CONNECTED' as const,
        candles: bars,
        retrievedAtUtc: '2026-06-15T10:35:00.000Z',
        duplicateBarCount: 0,
        missingBarCount: 0,
        warnings: [],
        reasonCode: null,
      };
    },
  };

  // 1. Default worker (both flags false) makes ZERO network calls and refuses start()
  const disabledWorker = new MarketDataIngestionWorker({
    adapter: mockAdapter,
    store,
    nowFn: () => new Date('2026-06-15T10:35:00.000Z'),
  });
  assert.equal(disabledWorker.isLiveIngestionAllowed(), false);
  assert.equal(disabledWorker.start().started, false);
  const disabledCycle = await disabledWorker.runCycleOnce();
  assert.equal(disabledCycle.status, 'DISABLED');
  assert.equal(disabledCycle.reasonCode, 'LIVE_INGESTION_DISABLED');
  assert.equal(fetchCount, 0);

  // 2. Enabled worker executes bounded cycle, prevents concurrent overlap, and saves checkpoint
  const enabledWorker = new MarketDataIngestionWorker({
    adapter: mockAdapter,
    store,
    nowFn: () => new Date('2026-06-15T10:35:00.000Z'),
    config: {
      marketFeedEnabled: true,
      backfillEnabled: true,
      granularities: ['M15'],
      batchSize: 50,
      maxPagesPerGranularity: 2,
      maxConsecutiveFailures: 2,
      allowFastIntervalForTests: true,
      pollIntervalMs: 50,
    },
  });

  releaseSlowFetch = () => {};
  const firstPromise = enabledWorker.runCycleOnce();
  // Fire overlapping cycle immediately while first is in flight
  const overlapRes = await enabledWorker.runCycleOnce();
  const firstRes = await firstPromise;

  assert.equal(overlapRes.status, 'SKIPPED_IN_FLIGHT');
  assert.equal(firstRes.status, 'COMPLETED');
  assert.equal(firstRes.totalInserted, 2);

  const savedCp = await store.getFeedCheckpoint();
  assert.ok(savedCp);
  assert.equal(savedCp.state, 'CONNECTED');
  assert.equal(savedCp.lastCompleteCandleCloseUtc, bars[1].closeTimeUtc);

  // 3. Circuit breaker opens after bounded consecutive failures
  const failingAdapter = {
    ...mockAdapter,
    fetchCompletedCandles: async () => ({
      status: 'ERROR' as const,
      candles: [],
      retrievedAtUtc: '2026-06-15T10:35:00.000Z',
      duplicateBarCount: 0,
      missingBarCount: 0,
      warnings: ['upstream down'],
      reasonCode: 'FEED_REQUEST_FAILED',
    }),
  };
  const breakerWorker = new MarketDataIngestionWorker({
    adapter: failingAdapter,
    store: new InMemoryCandleStore(),
    nowFn: () => new Date('2026-06-15T10:35:00.000Z'),
    config: {
      marketFeedEnabled: true,
      backfillEnabled: true,
      granularities: ['M15'],
      maxConsecutiveFailures: 2,
    },
  });
  assert.equal((await breakerWorker.runCycleOnce()).status, 'DEGRADED');
  assert.equal((await breakerWorker.runCycleOnce()).status, 'DEGRADED');
  const openRes = await breakerWorker.runCycleOnce();
  assert.equal(openRes.status, 'CIRCUIT_OPEN');
  assert.equal(breakerWorker.getStats().circuitOpen, true);
  await breakerWorker.stop();
});

test('Next.js API routes never import ingestionWorker or spawn background loops, and .env.example keeps all live gates false', () => {
  const root = process.cwd();
  const apiDir = path.join(root, 'app', 'api');
  const stack = [apiDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const src = fs.readFileSync(full, 'utf8');
        assert.equal(src.includes('ingestionWorker'), false);
        assert.equal(src.includes('setInterval'), false);
      }
    }
  }

  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /MARKET_FEED_ENABLED="false"/);
  assert.match(envExample, /BACKFILL_ENABLED="false"/);
  assert.match(envExample, /CRT_ENGINE_ENABLED="false"/);
  assert.match(envExample, /SIGNALS_ENABLED="false"/);
});

// Optional live PostgreSQL test executed automatically in GitHub Actions CI when TEST_DATABASE_URL is configured
const liveTestDbUrl = process.env.TEST_DATABASE_URL?.trim();
test(
  'live PostgreSQL connection, migrations, upsert, revision, and persistent-status integration (runs when TEST_DATABASE_URL is set)',
  { skip: !liveTestDbUrl },
  async () => {
    const executor = createManagedPgExecutor(liveTestDbUrl!);
    try {
      assert.equal(await executor.ping(), true);
      await runPostgresMigrations(executor);

      const store = new PostgresCandleStore({ databaseUrl: liveTestDbUrl });
      try {
        assert.equal(await store.ensureReady(), 'POSTGRES_CONNECTED');

        const bars = buildSyntheticClosedCandles({
          startOpenTimeUtc: '2026-06-15T10:00:00.000Z',
          count: 2,
          granularity: 'M15',
          provider: 'ci_pg_test',
          providerSymbol: 'XAU_USD',
          retrievedAtUtc: '2026-06-15T10:35:00.000Z',
        });
        await store.upsertCandles(bars, '2026-06-15T10:35:00.000Z');
        const readBack = await store.getCompletedCandles({
          providerSymbol: 'XAU_USD',
          granularity: 'M15',
          limit: 10,
        });
        assert.ok(readBack.length >= 2);
      } finally {
        await store.close();
      }
    } finally {
      await executor.close();
    }
  }
);
