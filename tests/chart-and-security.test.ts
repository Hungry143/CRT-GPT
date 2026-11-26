import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mountTradingViewEmbed,
  type EmbedDomAdapter,
  type MinimalContainerElement,
  type MinimalScriptElement,
  type TradingViewEmbedStatus,
} from '../client/services/tradingViewLoader';

interface MockScript extends MinimalScriptElement {
  dispatch: (type: 'load' | 'error') => void;
}

function createMockDom() {
  const children: unknown[] = [];
  const createdScripts: MockScript[] = [];

  const container: MinimalContainerElement = {
    replaceChildren: () => {
      children.length = 0;
    },
    appendChild: (node: unknown) => {
      children.push(node);
      return node;
    },
  };

  const adapter: EmbedDomAdapter<unknown, MockScript> = {
    createScript: () => {
      const attrs = new Map<string, string>();
      const listeners: Record<'load' | 'error', Array<() => void>> = {
        load: [],
        error: [],
      };
      const script: MockScript = {
        type: '',
        async: false,
        src: '',
        textContent: null,
        setAttribute: (k, v) => attrs.set(k, v),
        addEventListener: (type, listener) => {
          listeners[type].push(listener);
        },
        dispatch: (type) => {
          for (const fn of listeners[type]) fn();
        },
      };
      createdScripts.push(script);
      return script;
    },
    createWidgetRoot: () => ({
      replaceChildren: () => {},
      appendChild: (n: unknown) => n,
    }),
  };

  return { children, createdScripts, container, adapter };
}

test('TradingView embed handles StrictMode mount/unmount cycles without duplicate scripts', () => {
  const { children, createdScripts, container, adapter } = createMockDom();
  const statuses: TradingViewEmbedStatus[] = [];

  // Simulate React StrictMode mount -> unmount -> remount
  const cleanup1 = mountTradingViewEmbed({
    container,
    config: {
      symbol: 'OANDA:XAUUSD',
      interval: '60',
      timezone: 'America/New_York',
      theme: 'dark',
    },
    adapter,
    onStatusChange: (s) => statuses.push(s),
  });
  assert.equal(children.length, 1, 'single isolated embed wrapper mounted');

  cleanup1();
  assert.equal(children.length, 0, 'unmount clears container cleanly');

  const cleanup2 = mountTradingViewEmbed({
    container,
    config: {
      symbol: 'OANDA:XAUUSD',
      interval: '60',
      timezone: 'America/New_York',
      theme: 'dark',
    },
    adapter,
    onStatusChange: (s) => statuses.push(s),
  });
  assert.equal(children.length, 1, 'remount has exactly one isolated wrapper');

  // Firing load on the first unmounted script must NOT update state
  createdScripts[0]?.dispatch('load');
  assert.equal(statuses.includes('ready'), false);

  // Firing load on the active script transitions to ready
  createdScripts[1]?.dispatch('load');
  assert.equal(statuses.at(-1), 'ready');

  cleanup2();
  assert.equal(children.length, 0);
});

test('TradingView embed handles script load failure and DOM exceptions without crashing', () => {
  const { createdScripts, container, adapter } = createMockDom();
  const events: Array<{ status: TradingViewEmbedStatus; message?: string }> = [];

  const cleanup = mountTradingViewEmbed({
    container,
    config: {
      symbol: 'OANDA:XAUUSD',
      interval: '60',
      timezone: 'America/New_York',
      theme: 'dark',
    },
    adapter,
    onStatusChange: (status, message) => events.push({ status, message }),
  });

  createdScripts[0]?.dispatch('error');
  const last = events.at(-1);
  assert.equal(last?.status, 'error');
  assert.ok(last?.message && last.message.length > 0);
  cleanup();

  // Also ensure throwing DOM containers never throw uncaught errors
  const throwingContainer: MinimalContainerElement = {
    replaceChildren: () => {
      throw new Error('Simulated DOM failure');
    },
    appendChild: () => {
      throw new Error('Simulated append failure');
    },
  };

  let capturedStatus: TradingViewEmbedStatus | null = null;
  assert.doesNotThrow(() => {
    const teardown = mountTradingViewEmbed({
      container: throwingContainer,
      config: {
        symbol: 'OANDA:XAUUSD',
        interval: '60',
        timezone: 'America/New_York',
        theme: 'dark',
      },
      adapter,
      onStatusChange: (status) => {
        capturedStatus = status;
      },
    });
    teardown();
  });
  assert.equal(capturedStatus, 'error');
});

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

test('frontend code imports no server secrets and no broker/order-execution routes exist', () => {
  const root = process.cwd();
  const clientFiles = walkFiles(path.join(root, 'client'));
  assert.ok(clientFiles.length > 0, 'expected client files to exist');

  for (const file of clientFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      content.includes('GEMINI_API_KEY'),
      false,
      `client file ${file} must never reference GEMINI_API_KEY`
    );
    assert.equal(
      content.includes('@google/genai'),
      false,
      `client file ${file} must never import @google/genai`
    );
    assert.equal(
      /from\s+['"]@\/server\//.test(content),
      false,
      `client file ${file} must never import server modules`
    );
  }

  const apiRouteFiles = walkFiles(path.join(root, 'app', 'api'));
  const normalizedRoutes = apiRouteFiles
    .map((f) => path.relative(path.join(root, 'app', 'api'), f).replace(/\\/g, '/'))
    .sort();

  assert.deepEqual(normalizedRoutes, [
    'health/route.ts',
    'instruments/route.ts',
    'market/candles/route.ts',
    'market/session/route.ts',
    'market/status/route.ts',
    'signals/route.ts',
    'system/status/route.ts',
  ]);

  const forbiddenRoutePattern = /(order|trade|position|broker|execute|wallet|payment|checkout)/i;
  for (const route of normalizedRoutes) {
    assert.equal(
      forbiddenRoutePattern.test(route),
      false,
      `forbidden broker/execution route detected: ${route}`
    );
  }
});
