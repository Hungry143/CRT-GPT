/**
 * Isolated TradingView Advanced Chart embed lifecycle manager.
 * - Uses official public TradingView embed script (`embed-widget-advanced-chart.js`).
 * - Prevents duplicate script injection under React StrictMode double-mount.
 * - Strictly display-only: never reads, scrapes, or extracts market data from widget DOM.
 * - Handles load failures and timeouts cleanly without throwing or crashing the dashboard.
 */

export const TRADINGVIEW_EMBED_SCRIPT_SRC =
  'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

export const TRADINGVIEW_EXTERNAL_CHART_URL =
  'https://www.tradingview.com/chart/?symbol=OANDA%3AXAUUSD';

export type TradingViewEmbedStatus = 'loading' | 'ready' | 'error';

export interface TradingViewEmbedConfig {
  symbol: string;
  interval: 'D' | '240' | '60' | '15';
  timezone: string;
  theme: 'dark';
  locale?: string;
  hideSideToolbar?: boolean;
}

export interface MinimalScriptElement {
  type: string;
  async: boolean;
  src: string;
  textContent: string | null;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: 'load' | 'error', listener: () => void) => void;
}

export interface MinimalContainerElement<TNode = unknown> {
  replaceChildren: () => void;
  appendChild: (node: TNode) => unknown;
}

export interface EmbedDomAdapter<
  TNode = unknown,
  TScript extends TNode & MinimalScriptElement = TNode & MinimalScriptElement,
  TContainer extends TNode & MinimalContainerElement<TNode> = TNode &
    MinimalContainerElement<TNode>,
> {
  createScript: () => TScript;
  createWidgetRoot: () => TContainer;
  createWrapper?: () => TContainer;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function buildTradingViewWidgetConfig(
  config: TradingViewEmbedConfig
): Record<string, unknown> {
  return {
    autosize: true,
    symbol: config.symbol,
    interval: config.interval,
    timezone: config.timezone,
    theme: config.theme,
    style: '1',
    locale: config.locale ?? 'en',
    backgroundColor: 'rgba(11, 15, 20, 1)',
    gridColor: 'rgba(34, 45, 61, 0.45)',
    allow_symbol_change: false,
    calendar: false,
    hide_side_toolbar: config.hideSideToolbar ?? false,
    support_host: 'https://www.tradingview.com',
  };
}

export interface MountTradingViewOptions<
  TNode = unknown,
  TScript extends TNode & MinimalScriptElement = TNode & MinimalScriptElement,
  TContainer extends TNode & MinimalContainerElement<TNode> = TNode &
    MinimalContainerElement<TNode>,
> {
  container: MinimalContainerElement<TNode>;
  config: TradingViewEmbedConfig;
  adapter: EmbedDomAdapter<TNode, TScript, TContainer>;
  timeoutMs?: number;
  onStatusChange: (status: TradingViewEmbedStatus, errorMessage?: string) => void;
}

/**
 * Mounts the official TradingView embed script inside an isolated wrapper container and
 * returns a deterministic cleanup function safe for React StrictMode mount/unmount cycles.
 * Detaching the wrapper preserves `script.parentElement` for any in-flight script callback,
 * preventing TradingView's `_replaceScript` from throwing on `null.querySelector`.
 */
export function mountTradingViewEmbed<
  TNode = unknown,
  TScript extends TNode & MinimalScriptElement = TNode & MinimalScriptElement,
  TContainer extends TNode & MinimalContainerElement<TNode> = TNode &
    MinimalContainerElement<TNode>,
>({
  container,
  config,
  adapter,
  timeoutMs = 12000,
  onStatusChange,
}: MountTradingViewOptions<TNode, TScript, TContainer>): () => void {
  let disposed = false;
  let settled = false;
  const setTimer = adapter.setTimeoutFn ?? setTimeout;
  const clearTimer = adapter.clearTimeoutFn ?? clearTimeout;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const notify = (status: TradingViewEmbedStatus, errorMessage?: string) => {
    if (disposed) return;
    onStatusChange(status, errorMessage);
  };

  try {
    // Always wipe any prior embed instance so React StrictMode re-mounts never create duplicates.
    container.replaceChildren();
    notify('loading');

    const wrapper = adapter.createWrapper
      ? adapter.createWrapper()
      : adapter.createWidgetRoot();
    const widgetRoot = adapter.createWidgetRoot();
    const script = adapter.createScript();
    script.type = 'text/javascript';
    script.async = true;
    script.src = TRADINGVIEW_EMBED_SCRIPT_SRC;
    script.setAttribute('data-crt-tv-embed', 'true');
    script.textContent = JSON.stringify(buildTradingViewWidgetConfig(config));

    script.addEventListener('load', () => {
      if (disposed || settled) return;
      settled = true;
      if (timeoutId !== null) {
        clearTimer(timeoutId);
        timeoutId = null;
      }
      notify('ready');
    });

    script.addEventListener('error', () => {
      if (disposed || settled) return;
      settled = true;
      if (timeoutId !== null) {
        clearTimer(timeoutId);
        timeoutId = null;
      }
      notify(
        'error',
        'TradingView chart embed could not be loaded. External embed scripts may be blocked or offline.'
      );
    });

    timeoutId = setTimer(() => {
      if (disposed || settled) return;
      settled = true;
      notify(
        'error',
        'TradingView chart embed timed out while loading. Use the external TradingView link below.'
      );
    }, timeoutMs);

    wrapper.appendChild(widgetRoot);
    wrapper.appendChild(script);
    container.appendChild(wrapper);
  } catch (err) {
    settled = true;
    if (timeoutId !== null) {
      clearTimer(timeoutId);
      timeoutId = null;
    }
    const message =
      err instanceof Error
        ? err.message
        : 'Unexpected error while mounting TradingView chart embed.';
    notify('error', message);
  }

  return () => {
    disposed = true;
    if (timeoutId !== null) {
      clearTimer(timeoutId);
      timeoutId = null;
    }
    try {
      container.replaceChildren();
    } catch {
      // Never allow teardown errors to propagate out of React cleanup.
    }
  };
}
