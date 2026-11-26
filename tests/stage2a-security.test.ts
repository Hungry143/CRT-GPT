import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET as getHealth } from '../app/api/health/route';
import { GET as getSystemStatus } from '../app/api/system/status/route';
import { GET as getInstruments } from '../app/api/instruments/route';
import { GET as getSignals } from '../app/api/signals/route';
import { GET as getMarketStatus } from '../app/api/market/status/route';
import { GET as getMarketCandles } from '../app/api/market/candles/route';
import { GET as getMarketSession } from '../app/api/market/session/route';
import { redactSensitiveText } from '../server/marketData/adapter';

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test('OANDA_* secrets and Authorization headers never appear in client source or API JSON responses', async () => {
  const root = process.cwd();
  const clientFiles = walkFiles(path.join(root, 'client'));
  assert.ok(clientFiles.length > 0);

  const forbiddenClientPatterns = [
    /OANDA_API_TOKEN/,
    /OANDA_ACCOUNT_ID/,
    /OANDA_ENV/,
    /OANDA_INSTRUMENT/,
    /NEXT_PUBLIC_OANDA/,
    /DATABASE_URL/,
    /Authorization\s*:\s*['"`]Bearer/i,
    /tests\/fixtures\/syntheticCandles/,
  ];

  for (const file of clientFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const pattern of forbiddenClientPatterns) {
      assert.equal(
        pattern.test(src),
        false,
        `Forbidden secret/fixture reference ${pattern} found in client file ${file}`
      );
    }
  }

  // Also ensure synthetic fixtures are never imported anywhere under app/ or server/
  for (const dir of ['app', 'server']) {
    for (const file of walkFiles(path.join(root, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      assert.equal(
        src.includes('syntheticCandles'),
        false,
        `Production file ${file} must never import synthetic test fixtures`
      );
    }
  }

  // Verify live API payloads leak zero secrets or authorization headers
  const payloads = await Promise.all([
    (await getHealth()).text(),
    (await getSystemStatus()).text(),
    (await getInstruments()).text(),
    (await getSignals()).text(),
    (await getMarketStatus()).text(),
    (
      await getMarketCandles(
        new NextRequest(
          'http://localhost:3000/api/market/candles?instrument=XAUUSD&granularity=M15&limit=10'
        )
      )
    ).text(),
    (await getMarketSession()).text(),
  ]);

  for (const raw of payloads) {
    assert.equal(/OANDA_API_TOKEN|OANDA_ACCOUNT_ID|Bearer\s+/i.test(raw), false);
  }
});

test('server code contains zero order/trade/position execution endpoints and redactSensitiveText scrubs tokens & URL creds', () => {
  const root = process.cwd();
  const serverFiles = [
    ...walkFiles(path.join(root, 'server')),
    ...walkFiles(path.join(root, 'app', 'api')),
  ];

  for (const file of serverFiles) {
    const src = fs.readFileSync(file, 'utf8');
    // Verify no POST/PUT/DELETE OANDA order/trade calls exist
    assert.equal(
      /\/v3\/accounts\/[^'"]+\/(orders|trades|positions)\b/i.test(src),
      false,
      `Forbidden OANDA trading endpoint found in ${file}`
    );
  }

  const redacted = redactSensitiveText(
    'Failed GET https://user:pw@api-fxpractice.oanda.com?token=abc123 with Authorization: Bearer secret-tok-999 for acct-777',
    ['secret-tok-999', 'acct-777']
  );
  assert.equal(redacted.includes('secret-tok-999'), false);
  assert.equal(redacted.includes('acct-777'), false);
  assert.equal(redacted.includes('user:pw'), false);
  assert.equal(redacted.includes('abc123'), false);
});
