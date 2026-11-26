'use client';

import { AlertCircle } from 'lucide-react';
import type { SystemStatusResponse } from '@/shared/contracts/api';
import { deriveMarketStatusView, NO_DATA_DASH } from '@/shared/utils/display';

interface MarketStatusPanelProps {
  systemStatus: SystemStatusResponse | null;
  loading: boolean;
  error: string | null;
}

export function MarketStatusPanel({
  systemStatus,
  loading,
  error,
}: MarketStatusPanelProps) {
  const view = systemStatus
    ? deriveMarketStatusView(systemStatus.marketFeed)
    : null;

  const rows: Array<{ label: string; value: string; emphasis?: 'warn' | 'muted' }> =
    view
      ? [
          {
            label: 'Backend Feed State',
            value: view.feedStateLabel,
            emphasis: view.isConnected ? undefined : 'warn',
          },
          { label: 'Provider', value: view.providerLabel },
          { label: 'Feed Symbol', value: view.symbolLabel },
          { label: 'Last Valid Tick (UTC)', value: view.lastValidTickLabel },
          { label: 'Last Valid Candle (UTC)', value: view.lastValidCandleLabel },
          { label: 'Candle Quality', value: view.candleQualityLabel },
        ]
      : [
          { label: 'Backend Feed State', value: 'Not configured', emphasis: 'warn' },
          { label: 'Provider', value: 'Not configured' },
          { label: 'Feed Symbol', value: NO_DATA_DASH },
          { label: 'Last Valid Tick (UTC)', value: NO_DATA_DASH },
          { label: 'Last Valid Candle (UTC)', value: NO_DATA_DASH },
          { label: 'Candle Quality', value: 'Unavailable' },
        ];

  return (
    <section
      aria-labelledby="market-status-heading"
      className="bg-[#111720] border border-[#222D3D] rounded-lg flex flex-col"
    >
      <div className="px-5 py-3.5 border-b border-[#1F2937] flex items-center justify-between gap-2">
        <div>
          <h2
            id="market-status-heading"
            className="font-display text-sm font-semibold text-[#F8FAFC]"
          >
            Market Status
          </h2>
          <p className="text-xs text-[#8B9BB0] mt-0.5">
            Backend ingestion diagnostics for XAUUSD
          </p>
        </div>
        <span className="font-mono text-xs text-amber-300 whitespace-nowrap">
          {view ? view.feedStateLabel : 'Not configured'}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="mx-5 mt-4 p-3 rounded-md border border-red-500/35 bg-red-950/30 flex items-start gap-2.5 text-xs text-red-200"
        >
          <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-medium text-red-100">Diagnostics endpoint unavailable</p>
            <p className="mt-0.5 text-red-300/90">{error}</p>
          </div>
        </div>
      )}

      <div className="px-5 py-2 flex-1">
        {loading && !systemStatus ? (
          <div className="py-3 space-y-3" aria-busy="true" aria-label="Loading market status">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between py-1.5 border-b border-[#1A2230] last:border-b-0"
              >
                <div className="h-3.5 w-28 rounded bg-[#1A2332] animate-pulse" />
                <div className="h-3.5 w-24 rounded bg-[#1A2332] animate-pulse" />
              </div>
            ))}
          </div>
        ) : (
          <dl className="divide-y divide-[#1A2230] text-xs">
            {rows.map((row) => (
              <div
                key={row.label}
                className="py-2.5 flex items-center justify-between gap-4"
              >
                <dt className="text-[#8B9BB0]">{row.label}</dt>
                <dd
                  className={`font-mono tabular-nums text-right ${
                    row.emphasis === 'warn'
                      ? 'text-amber-300 font-medium'
                      : 'text-[#E2E8F0]'
                  }`}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="px-5 py-3 border-t border-[#1F2937] bg-[#0E131B] rounded-b-lg text-[11px] leading-relaxed text-[#8B9BB0]">
        Market open/closed state is intentionally not asserted from feed
        unavailability. No quotes or bid/ask values are simulated.
      </div>
    </section>
  );
}
