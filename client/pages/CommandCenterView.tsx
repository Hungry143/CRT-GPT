'use client';

import { ShieldAlert } from 'lucide-react';
import type { DiagnosticsSnapshot } from '@/client/services/apiClient';
import { DataIntegrityPanel } from '@/client/components/DataIntegrityPanel';
import { MarketStatusPanel } from '@/client/components/MarketStatusPanel';
import { OpportunityRadarPanel } from '@/client/components/OpportunityRadarPanel';
import { TimeframePanel } from '@/client/components/TimeframePanel';
import { TradingViewChartPanel } from '@/client/components/TradingViewChartPanel';
import { UniverseWatchlist } from '@/client/components/UniverseWatchlist';
import type { InstrumentKey } from '@/shared/tradingSystem/universe';

interface CommandCenterViewProps {
  diagnostics: DiagnosticsSnapshot;
  isLoading: boolean;
  selectedInstrument: InstrumentKey;
  onSelectInstrument: (instrument: InstrumentKey) => void;
  chartSymbol: string;
}

export function CommandCenterView({
  diagnostics,
  isLoading,
  selectedInstrument,
  onSelectInstrument,
  chartSymbol,
}: CommandCenterViewProps) {
  const systemStatus = diagnostics.systemStatus.data;

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
            The selected TradingView chart below is an independent third-party
            display widget only. Backend market-data ingestion, CRT analysis,
            and signal generation remain disabled until a verified provider is
            configured.
          </p>
        </div>
      </div>

      <UniverseWatchlist selectedInstrument={selectedInstrument} onSelectInstrument={onSelectInstrument} />
      <TradingViewChartPanel symbol={chartSymbol} />

      {selectedInstrument === 'XAUUSD' ? (
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
      ) : (
        <section className="rounded-lg border border-[#222D3D] bg-[#111720] p-5 text-sm text-[#94A3B8]">{selectedInstrument} backend market data and CRT signals are not yet verified. No XAUUSD feed metrics are reused for another pair. TradingView remains visual-only.</section>
      )}

      {selectedInstrument === 'XAUUSD' ? (
        <OpportunityRadarPanel signalsResponse={diagnostics.signals.data} systemStatus={systemStatus} compact />
      ) : null}
    </div>
  );
}
