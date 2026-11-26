import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as getHealth } from '../app/api/health/route';
import { GET as getSystemStatus } from '../app/api/system/status/route';
import { GET as getInstruments } from '../app/api/instruments/route';
import { GET as getSignals } from '../app/api/signals/route';
import { readFeatureGates } from '../server/config/featureGates';
import {
  HealthResponseSchema,
  InstrumentsResponseSchema,
  SignalsResponseSchema,
  SystemStatusResponseSchema,
} from '../shared/contracts/api';

test('GET /api/health returns HTTP 200 with parseable real UTC ISO-8601 timestamp', async () => {
  const before = Date.now();
  const res = await getHealth();
  const after = Date.now();

  assert.equal(res.status, 200);
  const body = await res.json();
  const parsed = HealthResponseSchema.parse(body);

  assert.equal(parsed.service, 'crt-intelligence');
  assert.equal(parsed.version, '0.1.0');
  assert.equal(parsed.status, 'ok');
  assert.match(parsed.serverTimeUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const ts = Date.parse(parsed.serverTimeUtc);
  assert.ok(!Number.isNaN(ts), 'serverTimeUtc must be parseable');
  assert.ok(ts >= before - 1000 && ts <= after + 1000, 'serverTimeUtc must be real server time');
});

test('GET /api/system/status defaults strictly to NOT_CONFIGURED, DISABLED, RESEARCH_ONLY, and orderExecutionEnabled=false', async () => {
  const res = await getSystemStatus();
  assert.equal(res.status, 200);

  const body = await res.json();
  const parsed = SystemStatusResponseSchema.parse(body);

  assert.equal(parsed.schemaVersion, '1.0.0');
  assert.equal(parsed.marketFeed.state, 'NOT_CONFIGURED');
  assert.equal(parsed.marketFeed.provider, null);
  assert.equal(parsed.marketFeed.symbol, null);
  assert.equal(parsed.marketFeed.lastTickAtUtc, null);
  assert.equal(parsed.marketFeed.lastClosedBarAtUtc, null);
  assert.equal(parsed.marketFeed.quality, 'UNAVAILABLE');
  assert.equal(parsed.crtEngine.state, 'DISABLED');
  assert.equal(parsed.crtEngine.ruleVersion, null);
  assert.equal(parsed.signalService.state, 'DISABLED');
  assert.equal(parsed.signalService.confirmedSignals, 0);
  assert.equal(parsed.riskMode, 'RESEARCH_ONLY');
  assert.equal(parsed.orderExecutionEnabled, false);
});

test('GET /api/instruments returns exactly one XAUUSD config-only instrument with no price fields', async () => {
  const res = await getInstruments();
  assert.equal(res.status, 200);

  const body = await res.json();
  const parsed = InstrumentsResponseSchema.parse(body);

  assert.equal(parsed.data.length, 1);
  const [xau] = parsed.data;
  assert.equal(xau.key, 'XAUUSD');
  assert.equal(xau.enabled, true);
  assert.equal(xau.marketDataConnected, false);
  assert.equal(xau.backendFeedSymbol, null);
  assert.equal(xau.displayChartSymbol, 'OANDA:XAUUSD');

  const forbiddenPriceKeys = ['price', 'bid', 'ask', 'last', 'close', 'open', 'spread', 'change'];
  for (const key of forbiddenPriceKeys) {
    assert.equal(key in xau, false, `instrument must not expose fabricated field "${key}"`);
  }
});

test('GET /api/signals returns empty array and ENGINE_DISABLED state', async () => {
  const res = await getSignals();
  assert.equal(res.status, 200);

  const body = await res.json();
  const parsed = SignalsResponseSchema.parse(body);

  assert.deepEqual(parsed, {
    data: [],
    state: 'ENGINE_DISABLED',
  });
});

test('feature gates default strictly to false when unset', () => {
  const gates = readFeatureGates({});
  assert.deepEqual(gates, {
    MARKET_FEED_ENABLED: false,
    CRT_ENGINE_ENABLED: false,
    SIGNALS_ENABLED: false,
  });
});
