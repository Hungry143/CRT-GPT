import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import {
  GET as getDiagnosticRoute,
  POST as postDiagnosticRoute,
  DELETE as deleteDiagnosticRoute,
} from '../app/api/diagnostics/oanda-practice-smoke/route';
import {
  createDiagnosticRateLimitState,
  handleOandaPracticeDiagnosticRequest,
  inspectOandaCredentialPresence,
  resetDiagnosticRateLimitState,
  type DiagnosticRequestContext,
  type OandaPracticeDiagnosticResponse,
} from '../server/routes/oandaPracticeDiagnostic';
import {
  buildSyntheticClosedCandles,
  buildSyntheticOandaRawPayload,
} from './fixtures/syntheticCandles';

const STRONG_DIAG_SECRET = 'diag-secret-9f8e7d6c5b4a3210fedcba9876543210';
const MOCK_OANDA_TOKEN = 'oanda-practice-token-do-not-expose-5544332211';
const MOCK_OANDA_ACCOUNT = '101-001-4455667-001';

function makeReq(
  overrides: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  } = {}
): DiagnosticRequestContext {
  const headerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(overrides.headers ?? {})) {
    headerMap.set(k.toLowerCase(), v);
  }
  return {
    method: overrides.method ?? 'POST',
    url:
      overrides.url ??
      'http://localhost:3000/api/diagnostics/oanda-practice-smoke',
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null;
      },
    },
  };
}

test('Diagnostic access control: disabled by default, POST-only, blocks production & shared hosts, enforces separate strong secret, rejects query secrets, and enforces rate limits', async () => {
  const nowUtc = new Date('2026-06-15T10:50:00.000Z');
  let upstreamCalls = 0;
  const failIfCalledFetch: typeof fetch = async () => {
    upstreamCalls += 1;
    throw new Error('Upstream OANDA must not be called when access control fails');
  };

  // 1. Disabled by default (404)
  const disabledRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({ headers: { authorization: `Bearer ${STRONG_DIAG_SECRET}` } }),
    {
      env: { NODE_ENV: 'development' },
      nowFn: () => nowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
    }
  );
  assert.equal(disabledRes.httpStatus, 404);
  assert.equal(
    (disabledRes.body as { reasonCode: string }).reasonCode,
    'DIAGNOSTIC_DISABLED'
  );

  // 2. Non-POST methods rejected with 405 Method Not Allowed
  const getRes = await getDiagnosticRoute();
  assert.equal(getRes.status, 405);
  assert.equal(getRes.headers.get('allow'), 'POST');
  const delRes = await deleteDiagnosticRoute();
  assert.equal(delRes.status, 405);

  // Also default Next.js POST handler returns 404 when env flag is unset
  resetDiagnosticRateLimitState();
  const defaultPostRes = await postDiagnosticRoute(
    new NextRequest(
      'http://localhost:3000/api/diagnostics/oanda-practice-smoke',
      { method: 'POST' }
    )
  );
  assert.equal(defaultPostRes.status, 404);

  // 3. Blocked in NODE_ENV=production, APP_ENV=production, VERCEL_ENV=production, and ais-pre-* shared hosts
  const blockedEnvs: Array<{
    label: string;
    env: Record<string, string>;
    host?: string;
  }> = [
    {
      label: 'NODE_ENV=production',
      env: {
        NODE_ENV: 'production',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
      },
    },
    {
      label: 'APP_ENV=production',
      env: {
        NODE_ENV: 'development',
        APP_ENV: 'production',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
      },
    },
    {
      label: 'VERCEL_ENV=production',
      env: {
        NODE_ENV: 'development',
        VERCEL_ENV: 'production',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
      },
    },
    {
      label: 'shared preview host ais-pre-*',
      env: {
        NODE_ENV: 'development',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
      },
      host: 'ais-pre-example-12345.asia-east1.run.app',
    },
  ];

  for (const tc of blockedEnvs) {
    const res = await handleOandaPracticeDiagnosticRequest(
      makeReq({
        headers: {
          authorization: `Bearer ${STRONG_DIAG_SECRET}`,
          ...(tc.host ? { 'x-forwarded-host': tc.host } : {}),
        },
      }),
      {
        env: tc.env,
        nowFn: () => nowUtc,
        rateLimitState: createDiagnosticRateLimitState(),
        smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
      }
    );
    assert.equal(
      res.httpStatus,
      404,
      `${tc.label} must block diagnostic with 404`
    );
  }

  // 4. Rejects missing, short (<32 chars), or reused OANDA secret
  const missingSecretRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({ headers: { authorization: `Bearer ${STRONG_DIAG_SECRET}` } }),
    {
      env: {
        NODE_ENV: 'development',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
      },
      nowFn: () => nowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
    }
  );
  assert.equal(missingSecretRes.httpStatus, 503);

  const shortSecretRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({ headers: { authorization: 'Bearer short-secret' } }),
    {
      env: {
        NODE_ENV: 'development',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: 'short-secret',
      },
      nowFn: () => nowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
    }
  );
  assert.equal(shortSecretRes.httpStatus, 503);

  const reusedSecretRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({ headers: { authorization: `Bearer ${MOCK_OANDA_TOKEN}` } }),
    {
      env: {
        NODE_ENV: 'development',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: MOCK_OANDA_TOKEN,
        OANDA_API_TOKEN: MOCK_OANDA_TOKEN,
      },
      nowFn: () => nowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
    }
  );
  assert.equal(reusedSecretRes.httpStatus, 503);
  assert.equal(
    (reusedSecretRes.body as { reasonCode: string }).reasonCode,
    'DIAGNOSTIC_SECRET_MUST_BE_SEPARATE'
  );

  // 5. Rejects query-string secrets (400)
  const querySecretRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({
      url: `http://localhost:3000/api/diagnostics/oanda-practice-smoke?secret=${STRONG_DIAG_SECRET}`,
      headers: { authorization: `Bearer ${STRONG_DIAG_SECRET}` },
    }),
    {
      env: {
        NODE_ENV: 'development',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
      },
      nowFn: () => nowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
    }
  );
  assert.equal(querySecretRes.httpStatus, 400);
  assert.equal(
    (querySecretRes.body as { reasonCode: string }).reasonCode,
    'QUERY_SECRET_FORBIDDEN'
  );

  // 6. Rejects unauthenticated and wrong-secret requests (401)
  const unauthRes = await handleOandaPracticeDiagnosticRequest(makeReq(), {
    env: {
      NODE_ENV: 'development',
      OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
      OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
    },
    nowFn: () => nowUtc,
    rateLimitState: createDiagnosticRateLimitState(),
    smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
  });
  assert.equal(unauthRes.httpStatus, 401);

  const wrongAuthRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({
      headers: {
        'x-crt-diagnostic-secret': 'wrong-secret-00000000000000000000000000',
      },
    }),
    {
      env: {
        NODE_ENV: 'development',
        OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
        OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
      },
      nowFn: () => nowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: failIfCalledFetch } },
    }
  );
  assert.equal(wrongAuthRes.httpStatus, 401);

  // 7. Rate limiter blocks bursts cleanly with 429 + Retry-After
  const rlState = createDiagnosticRateLimitState();
  const validEnv = {
    NODE_ENV: 'development',
    OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
    OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
  };
  for (let i = 0; i < 2; i++) {
    const ok = await handleOandaPracticeDiagnosticRequest(
      makeReq({
        headers: {
          'x-crt-diagnostic-secret': STRONG_DIAG_SECRET,
          'x-forwarded-for': '203.0.113.10',
        },
      }),
      {
        env: validEnv,
        nowFn: () => nowUtc,
        rateLimitState: rlState,
        rateLimitConfig: { windowMs: 60_000, maxPerClient: 2, maxGlobal: 5 },
      }
    );
    assert.equal(ok.httpStatus, 200);
  }
  const limited = await handleOandaPracticeDiagnosticRequest(
    makeReq({
      headers: {
        'x-crt-diagnostic-secret': STRONG_DIAG_SECRET,
        'x-forwarded-for': '203.0.113.10',
      },
    }),
    {
      env: validEnv,
      nowFn: () => nowUtc,
      rateLimitState: rlState,
      rateLimitConfig: { windowMs: 60_000, maxPerClient: 2, maxGlobal: 5 },
    }
  );
  assert.equal(limited.httpStatus, 429);
  assert.ok(Number(limited.headers['Retry-After']) >= 1);
  assert.equal(upstreamCalls, 0);
});

test('Diagnostic integration: returns presence flags only (zero secret leakage), verifies XAU_USD entitlement + M15/H1/H4/D1 candles, and distinguishes fresh live data from stale valid historical data', async () => {
  const baseEnv = {
    NODE_ENV: 'development',
    OANDA_PRACTICE_DIAGNOSTIC_ENABLED: 'true',
    OANDA_PRACTICE_DIAGNOSTIC_SECRET: STRONG_DIAG_SECRET,
    OANDA_ENV: 'practice',
    OANDA_ACCOUNT_ID: MOCK_OANDA_ACCOUNT,
    OANDA_API_TOKEN: MOCK_OANDA_TOKEN,
    OANDA_INSTRUMENT: 'XAU_USD',
    MARKET_FEED_ENABLED: 'false',
    BACKFILL_ENABLED: 'false',
    CRT_ENGINE_ENABLED: 'false',
    SIGNALS_ENABLED: 'false',
  };

  // Presence helper returns strictly boolean flags, never values
  const presence = inspectOandaCredentialPresence(baseEnv);
  assert.deepEqual(presence, {
    OANDA_ENV_PRESENT: true,
    OANDA_ENV_IS_PRACTICE: true,
    OANDA_ACCOUNT_ID_PRESENT: true,
    OANDA_API_TOKEN_PRESENT: true,
    OANDA_INSTRUMENT_PRESENT: true,
    OANDA_INSTRUMENT_IS_XAU_USD: true,
  });

  const freshNowUtc = new Date('2026-06-16T10:50:00.000Z');
  const candlesByOandaGran: Record<
    string,
    ReturnType<typeof buildSyntheticOandaRawPayload>
  > = {
    M15: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-16T10:00:00.000Z',
        count: 3,
        granularity: 'M15',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: freshNowUtc.toISOString(),
      }),
      'M15'
    ),
    H1: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-16T07:00:00.000Z',
        count: 3,
        granularity: 'H1',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: freshNowUtc.toISOString(),
      }),
      'H1'
    ),
    H4: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-16T01:00:00.000Z',
        count: 2,
        granularity: 'H4',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: freshNowUtc.toISOString(),
      }),
      'H4'
    ),
    D: buildSyntheticOandaRawPayload(
      buildSyntheticClosedCandles({
        startOpenTimeUtc: '2026-06-13T21:00:00.000Z',
        count: 2,
        granularity: 'D1',
        provider: 'oanda_v20',
        providerSymbol: 'XAU_USD',
        retrievedAtUtc: freshNowUtc.toISOString(),
      }),
      'D1'
    ),
  };

  const mockPracticeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith('https://api-fxpractice.oanda.com/'));
    assert.equal(init?.method ?? 'GET', 'GET');
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
    const gran = new URL(url).searchParams.get('granularity') ?? '';
    return new Response(JSON.stringify(candlesByOandaGran[gran]), {
      status: 200,
    });
  };

  // Case A: Fresh open-session candles -> FRESH_LIVE_SYNCED (both historicalCandlesValid AND liveFeedFreshNow are true)
  const freshRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({ headers: { authorization: `Bearer ${STRONG_DIAG_SECRET}` } }),
    {
      env: baseEnv,
      nowFn: () => freshNowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: mockPracticeFetch } },
    }
  );
  assert.equal(freshRes.httpStatus, 200);
  const freshBody = freshRes.body as OandaPracticeDiagnosticResponse;
  assert.equal(freshBody.status, 'PASSED');
  assert.equal(freshBody.entitlementVerified, true);
  assert.equal(freshBody.dataFreshnessSummary.historicalCandlesValid, true);
  assert.equal(freshBody.dataFreshnessSummary.liveFeedFreshNow, true);
  assert.equal(
    freshBody.dataFreshnessSummary.freshnessClassification,
    'FRESH_LIVE_SYNCED'
  );
  assert.deepEqual(
    freshBody.timeframes.map((t) => t.granularity),
    ['M15', 'H1', 'H4', 'D1']
  );
  for (const tf of freshBody.timeframes) {
    assert.equal(tf.validHistoricalData, true);
    assert.equal(tf.isFreshLiveData, true);
    assert.equal(tf.freshnessState, 'FRESH_LIVE');
    assert.equal(tf.missingBarCount, 0);
  }
  assert.equal(freshBody.guarantees.readOnly, true);
  assert.equal(freshBody.guarantees.practiceOnly, true);
  assert.equal(freshBody.guarantees.continuousIngestionActivated, false);
  assert.equal(freshBody.guarantees.backfillActivated, false);
  assert.equal(freshBody.guarantees.marketFeedEnabled, false);
  assert.equal(freshBody.guarantees.backfillEnabled, false);
  assert.equal(freshBody.guarantees.crtEngineEnabled, false);
  assert.equal(freshBody.guarantees.signalsEnabled, false);
  assert.equal(freshBody.guarantees.orderExecutionEnabled, false);

  // Zero secret exposure in serialized response
  const serializedFresh = JSON.stringify(freshBody);
  assert.equal(serializedFresh.includes(STRONG_DIAG_SECRET), false);
  assert.equal(serializedFresh.includes(MOCK_OANDA_TOKEN), false);
  assert.equal(serializedFresh.includes(MOCK_OANDA_ACCOUNT), false);
  assert.equal(serializedFresh.includes('api-fxpractice.oanda.com'), false);

  // Case B: Valid historical candles evaluated 4 hours later -> STALE is NEVER treated as fresh live proof!
  const staleNowUtc = new Date('2026-06-16T14:50:00.000Z');
  const staleRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({ headers: { 'x-crt-diagnostic-secret': STRONG_DIAG_SECRET } }),
    {
      env: baseEnv,
      nowFn: () => staleNowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: mockPracticeFetch } },
    }
  );
  assert.equal(staleRes.httpStatus, 200);
  const staleBody = staleRes.body as OandaPracticeDiagnosticResponse;
  assert.equal(staleBody.status, 'PASSED');
  assert.equal(staleBody.entitlementVerified, true);
  assert.equal(staleBody.dataFreshnessSummary.historicalCandlesValid, true);
  assert.equal(staleBody.dataFreshnessSummary.liveFeedFreshNow, false);
  assert.equal(
    staleBody.dataFreshnessSummary.freshnessClassification,
    'VALID_HISTORICAL_ONLY_STALE'
  );
  const m15Stale = staleBody.timeframes.find((t) => t.granularity === 'M15');
  assert.ok(m15Stale);
  assert.equal(m15Stale.feedStatus, 'STALE');
  assert.equal(m15Stale.validHistoricalData, true);
  assert.equal(m15Stale.isFreshLiveData, false);
  assert.equal(m15Stale.freshnessState, 'STALE_HISTORICAL');
  assert.equal(m15Stale.reasonCode, 'FEED_DATA_STALE');

  // Case C: Live environment rejected even when diagnostic auth succeeds (presence flags only)
  const liveRejectRes = await handleOandaPracticeDiagnosticRequest(
    makeReq({ headers: { authorization: `Bearer ${STRONG_DIAG_SECRET}` } }),
    {
      env: { ...baseEnv, OANDA_ENV: 'live' },
      nowFn: () => freshNowUtc,
      rateLimitState: createDiagnosticRateLimitState(),
      smokeOptions: { deps: { fetchFn: mockPracticeFetch } },
    }
  );
  assert.equal(liveRejectRes.httpStatus, 200);
  const liveBody = liveRejectRes.body as OandaPracticeDiagnosticResponse;
  assert.equal(liveBody.status, 'REJECTED');
  assert.equal(liveBody.reasonCode, 'PRACTICE_ENV_REQUIRED');
  assert.equal(liveBody.credentialPresence.OANDA_ENV_PRESENT, true);
  assert.equal(liveBody.credentialPresence.OANDA_ENV_IS_PRACTICE, false);
  assert.equal(liveBody.dataFreshnessSummary.historicalCandlesValid, false);
  assert.equal(liveBody.dataFreshnessSummary.liveFeedFreshNow, false);
  assert.equal(JSON.stringify(liveBody).includes(MOCK_OANDA_TOKEN), false);
  assert.equal(JSON.stringify(liveBody).includes(MOCK_OANDA_ACCOUNT), false);
});

test('Diagnostic secret & env flags never appear in client source and .env.example keeps diagnostic disabled by default', () => {
  const root = process.cwd();
  const stack = [path.join(root, 'client')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const src = fs.readFileSync(full, 'utf8');
        assert.equal(src.includes('OANDA_PRACTICE_DIAGNOSTIC'), false);
        assert.equal(src.includes('oanda-practice-smoke'), false);
      }
    }
  }

  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /OANDA_PRACTICE_DIAGNOSTIC_ENABLED="false"/);
  assert.match(envExample, /OANDA_PRACTICE_DIAGNOSTIC_SECRET=""/);
  assert.match(envExample, /MARKET_FEED_ENABLED="false"/);
  assert.match(envExample, /BACKFILL_ENABLED="false"/);
  assert.match(envExample, /CRT_ENGINE_ENABLED="false"/);
  assert.match(envExample, /SIGNALS_ENABLED="false"/);
});
