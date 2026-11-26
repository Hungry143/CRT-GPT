'use client';

import { AlertCircle } from 'lucide-react';
import type { DiagnosticsSnapshot } from '@/client/services/apiClient';
import { TimeframePanel } from '@/client/components/TimeframePanel';
import { TradingViewChartPanel } from '@/client/components/TradingViewChartPanel';
import { NO_DATA_DASH } from '@/shared/utils/display';

interface InstrumentAnalysisViewProps {
  diagnostics: DiagnosticsSnapshot;
}

export function InstrumentAnalysisView({
  diagnostics,
}: InstrumentAnalysisViewProps) {
  const instrument = diagnostics.instruments.data?.data[0] ?? null;
  const error = diagnostics.instruments.error;

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="instrument-profile-heading"
        className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-[#1F2937] flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              id="instrument-profile-heading"
              className="font-display text-base font-semibold text-[#F8FAFC]"
            >
              XAUUSD Configuration Profile
            </h2>
            <p className="text-xs text-[#8B9BB0] mt-0.5">
              Configuration-only registry record — no quotes, spreads, or
              derived pricing in Stage 1
            </p>
          </div>
          <span className="font-mono text-xs text-amber-300">
            Market Data: Not connected
          </span>
        </div>

        {error ? (
          <div
            role="alert"
            className="m-5 p-3.5 rounded-md border border-red-500/35 bg-red-950/30 flex items-start gap-2.5 text-xs text-red-200"
          >
            <AlertCircle
              className="h-4 w-4 text-red-400 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-red-100">
                Unable to load instrument configuration
              </p>
              <p className="mt-0.5 text-red-300/90">{error}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#1F2937] text-xs">
            <dl className="p-5 divide-y divide-[#1A2230]">
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Instrument Key</dt>
                <dd className="font-mono font-semibold text-amber-400">
                  {instrument?.key ?? 'XAUUSD'}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Description</dt>
                <dd className="text-[#E2E8F0] text-right">
                  {instrument?.displayName ?? 'Gold / US Dollar (Spot Reference)'}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Enabled in Registry</dt>
                <dd className="font-mono text-[#E2E8F0]">
                  {instrument ? (instrument.enabled ? 'true' : 'false') : 'true'}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Market Data Connected</dt>
                <dd className="font-mono text-amber-300">
                  {instrument
                    ? instrument.marketDataConnected
                      ? 'true'
                      : 'false'
                    : 'false'}
                </dd>
              </div>
            </dl>

            <dl className="p-5 divide-y divide-[#1A2230]">
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Backend Feed Symbol</dt>
                <dd className="font-mono text-[#94A3B8]">
                  {instrument?.backendFeedSymbol ?? NO_DATA_DASH}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Display Chart Symbol</dt>
                <dd className="font-mono text-[#E2E8F0]">
                  {instrument?.displayChartSymbol ?? 'OANDA:XAUUSD'}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Active Timeframes</dt>
                <dd className="font-mono text-[#E2E8F0]">
                  {instrument?.supportedTimeframes.join(', ') ?? 'D1, H4, H1, M15'}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-[#8B9BB0]">Last Quote / Bias</dt>
                <dd className="font-mono text-[#64748B]">{NO_DATA_DASH}</dd>
              </div>
            </dl>
          </div>
        )}

        <div className="px-5 py-3 border-t border-[#1F2937] bg-[#0E131B] text-[11px] text-[#8B9BB0]">
          {instrument?.displayChartNote ??
            'OANDA:XAUUSD is a TradingView chart display selection only and does not assert or connect a backend market-data provider.'}
        </div>
      </section>

      <TradingViewChartPanel
        symbol={instrument?.displayChartSymbol ?? 'OANDA:XAUUSD'}
      />

      <TimeframePanel systemStatus={diagnostics.systemStatus.data} />
    </div>
  );
}
