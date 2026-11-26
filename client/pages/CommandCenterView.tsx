'use client';

import { ShieldAlert } from 'lucide-react';
import type { DiagnosticsSnapshot } from '@/client/services/apiClient';
import { DataIntegrityPanel } from '@/client/components/DataIntegrityPanel';
import { MarketStatusPanel } from '@/client/components/MarketStatusPanel';
import { OpportunityRadarPanel } from '@/client/components/OpportunityRadarPanel';
import { TimeframePanel } from '@/client/components/TimeframePanel';
import { TradingViewChartPanel } from '@/client/components/TradingViewChartPanel';

interface CommandCenterViewProps {
  diagnostics: DiagnosticsSnapshot;
  isLoading: boolean;
}

export function CommandCenterView({
  diagnostics,
  isLoading,
}: CommandCenterViewProps) {
  const systemStatus = diagnostics.systemStatus.data;
  const instrument = diagnostics.instruments.data?.data[0];

  return (
    <div className="space-y-6">
      <div
        role="status"
        className="rounded-lg border border-amber-500/35 bg-[#17140D] px-4 sm:px-5 py-3.5 flex items-start gap-3"
      >
        <ShieldAlert
          className="h-4 w-4 text-amber-400 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="min-w-0 text-xs leading-relaxed">
          <p className="font-display font-semibold text-amber-200 tracking-wide">
            DATA SOURCE NOT CONNECTED
          </p>
          <p className="mt-1 text-[#CBD5E1]">
            The embedded TradingView chart below is an independent third-party
            display widget only. Backend market-data ingestion, CRT analysis,
            and signal generation remain disabled until a verified provider is
            configured.
          </p>
        </div>
      </div>

      <TradingViewChartPanel
        symbol={instrument?.displayChartSymbol ?? 'OANDA:XAUUSD'}
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch">
        <MarketStatusPanel
          systemStatus={systemStatus}
          loading={isLoading}
          error={diagnostics.systemStatus.error}
        />
        <TimeframePanel systemStatus={systemStatus} />
      </div>

      <DataIntegrityPanel
        marketStatus={diagnostics.marketStatus.data}
        marketSession={diagnostics.marketSession.data}
      />

      <OpportunityRadarPanel
        signalsResponse={diagnostics.signals.data}
        systemStatus={systemStatus}
        compact
      />
    </div>
  );
}
