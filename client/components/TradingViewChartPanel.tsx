'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Maximize2,
  Minimize2,
  RotateCw,
} from 'lucide-react';
import {
  mountTradingViewEmbed,
  TRADINGVIEW_EXTERNAL_CHART_URL,
  type TradingViewEmbedConfig,
  type TradingViewEmbedStatus,
} from '@/client/services/tradingViewLoader';
import { MARKET_REFERENCE_TIMEZONE } from '@/shared/utils/time';

type ChartHeightPreset = 'compact' | 'standard' | 'expanded';

const HEIGHT_CLASSES: Record<ChartHeightPreset, string> = {
  compact: 'h-[320px] sm:h-[360px]',
  standard: 'h-[420px] sm:h-[500px]',
  expanded: 'h-[560px] sm:h-[640px]',
};

const INTERVAL_OPTIONS: Array<{
  label: string;
  value: TradingViewEmbedConfig['interval'];
}> = [
  { label: 'D1', value: 'D' },
  { label: 'H4', value: '240' },
  { label: 'H1', value: '60' },
  { label: 'M15', value: '15' },
];

interface TradingViewChartPanelProps {
  symbol?: string;
}

export function TradingViewChartPanel({
  symbol = 'OANDA:XAUUSD',
}: TradingViewChartPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [interval, setInterval] =
    useState<TradingViewEmbedConfig['interval']>('60');
  const [sizePreset, setSizePreset] = useState<ChartHeightPreset>('standard');
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  const [embedStatus, setEmbedStatus] =
    useState<TradingViewEmbedStatus>('loading');
  const [embedError, setEmbedError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let cleanupEmbed: (() => void) | null = null;
    const isNarrowViewport =
      typeof window !== 'undefined' && window.innerWidth < 640;

    // Deferring by one frame ensures React StrictMode's immediate dev unmount cancels
    // before any external TradingView script network request is dispatched.
    const frameId = window.requestAnimationFrame(() => {
      if (cancelled || !containerRef.current) return;
      cleanupEmbed = mountTradingViewEmbed({
        container: containerRef.current,
        config: {
          symbol,
          interval,
          timezone: MARKET_REFERENCE_TIMEZONE,
          theme: 'dark',
          hideSideToolbar: isNarrowViewport,
        },
        adapter: {
          createScript: () => document.createElement('script'),
          createWrapper: () => {
            const wrapper = document.createElement('div');
            wrapper.className = 'tradingview-widget-container h-full w-full';
            return wrapper;
          },
          createWidgetRoot: () => {
            const el = document.createElement('div');
            el.className = 'tradingview-widget-container__widget h-full w-full';
            return el;
          },
        },
        timeoutMs: 12000,
        onStatusChange: (status, message) => {
          setEmbedStatus(status);
          setEmbedError(message ?? null);
        },
      });
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      cleanupEmbed?.();
    };
  }, [symbol, interval, reloadNonce]);

  return (
    <section
      aria-labelledby="tv-chart-heading"
      className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
    >
      <div className="px-4 sm:px-5 py-3.5 border-b border-[#1F2937] flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2
              id="tv-chart-heading"
              className="font-display text-sm sm:text-[15px] font-semibold text-[#F8FAFC]"
            >
              TradingView chart display — not engine data feed
            </h2>
          </div>
          <p className="text-xs text-[#8B9BB0] flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-mono text-[#CBD5E1]">{symbol}</span>
            <span aria-hidden="true">·</span>
            <span>Third-party visual embed only</span>
            <span aria-hidden="true">·</span>
            <span>Isolated from backend CRT analysis</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Display-only TradingView chart interval selector */}
          <div
            role="group"
            aria-label="Chart display interval"
            className="inline-flex items-center rounded-md border border-[#222D3D] bg-[#0B0F14] p-0.5"
          >
            {INTERVAL_OPTIONS.map((opt) => {
              const active = interval === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setInterval(opt.value)}
                  aria-pressed={active}
                  className={`px-2.5 py-1.5 text-xs font-mono rounded transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-amber-500 ${
                    active
                      ? 'bg-[#1D2838] text-amber-300 font-medium'
                      : 'text-[#8B9BB0] hover:text-[#E2E8F0]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {/* Responsive / mobile sizing controls */}
          <div
            role="group"
            aria-label="Chart viewport height"
            className="inline-flex items-center rounded-md border border-[#222D3D] bg-[#0B0F14] p-0.5"
          >
            {(
              [
                { id: 'compact', label: 'Compact', Icon: Minimize2 },
                { id: 'standard', label: 'Standard', Icon: null },
                { id: 'expanded', label: 'Tall', Icon: Maximize2 },
              ] as const
            ).map(({ id, label }) => {
              const active = sizePreset === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSizePreset(id)}
                  aria-pressed={active}
                  className={`px-2.5 py-1.5 text-xs rounded transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-amber-500 ${
                    active
                      ? 'bg-[#1D2838] text-[#F8FAFC] font-medium'
                      : 'text-[#8B9BB0] hover:text-[#E2E8F0]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            aria-label="Reload TradingView chart embed"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#222D3D] bg-[#0B0F14] text-[#94A3B8] hover:bg-[#18212E] hover:text-[#F8FAFC] transition-colors focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <a
            href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 px-3 rounded-md border border-[#222D3D] bg-[#0B0F14] text-xs font-medium text-[#CBD5E1] hover:bg-[#18212E] hover:text-[#F8FAFC] transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <span>Open TradingView</span>
            <ExternalLink className="h-3 w-3 text-[#8B9BB0]" aria-hidden="true" />
          </a>
        </div>
      </div>

      <div
        className={`relative w-full bg-[#0B0F14] transition-[height] duration-150 ${HEIGHT_CLASSES[sizePreset]}`}
        data-testid="tradingview-chart-viewport"
        data-embed-status={embedStatus}
        data-size-preset={sizePreset}
      >
        <div
          ref={containerRef}
          className="tradingview-widget-container h-full w-full"
        />

        {embedStatus === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#0B0F14]/85 px-6 text-center">
            <p className="text-sm font-medium text-[#E2E8F0]">
              Loading TradingView display widget ({symbol})
            </p>
            <p className="mt-1 text-xs text-[#8B9BB0]">
              Visual chart embed only — backend market feed remains not
              configured.
            </p>
          </div>
        )}

        {embedStatus === 'error' && (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center bg-[#0B0F14] px-6 text-center"
          >
            <AlertTriangle
              className="h-6 w-6 text-amber-400 mb-3"
              aria-hidden="true"
            />
            <h3 className="font-display text-sm font-semibold text-[#F8FAFC]">
              TradingView embed unavailable
            </h3>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[#94A3B8]">
              {embedError ??
                'The external TradingView chart widget could not be loaded in this environment. No synthetic candles are substituted.'}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setReloadNonce((n) => n + 1)}
                className="inline-flex h-9 items-center gap-1.5 px-4 rounded-md border border-[#2A374A] bg-[#161E29] text-xs font-medium text-[#F8FAFC] hover:bg-[#1E293B] transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-amber-500"
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Retry embed</span>
              </button>
              <a
                href={TRADINGVIEW_EXTERNAL_CHART_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1.5 px-4 rounded-md bg-amber-500 text-xs font-semibold text-[#0B0F14] hover:bg-amber-400 transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-amber-300"
              >
                <span>Open TradingView</span>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>
        )}
      </div>

      <div className="px-4 sm:px-5 py-2.5 bg-[#0E131B] border-t border-[#1F2937] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8B9BB0]">
        <span>
          Display choice: <span className="font-mono text-[#CBD5E1]">{symbol}</span>{' '}
          does not assert a backend feed provider or symbol mapping.
        </span>
        <span>
          Chart DOM is strictly isolated and never scraped for prices.
        </span>
      </div>
    </section>
  );
}
