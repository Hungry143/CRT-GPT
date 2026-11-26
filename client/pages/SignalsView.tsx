'use client';

import type { DiagnosticsSnapshot } from '@/client/services/apiClient';
import { OpportunityRadarPanel } from '@/client/components/OpportunityRadarPanel';

interface SignalsViewProps {
  diagnostics: DiagnosticsSnapshot;
}

export function SignalsView({ diagnostics }: SignalsViewProps) {
  return (
    <div className="space-y-6">
      <OpportunityRadarPanel
        signalsResponse={diagnostics.signals.data}
        systemStatus={diagnostics.systemStatus.data}
        compact={false}
      />

      <section
        aria-labelledby="signals-governance-heading"
        className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-[#1F2937]">
          <h2
            id="signals-governance-heading"
            className="font-display text-sm font-semibold text-[#F8FAFC]"
          >
            Signal Governance & Safety Boundaries
          </h2>
          <p className="text-xs text-[#8B9BB0] mt-0.5">
            Hard invariants enforced across the CRT Intelligence platform
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#1F2937] text-xs">
          <div className="p-5 space-y-1.5">
            <h3 className="font-medium text-[#E2E8F0]">
              Discretionary Signal-Only
            </h3>
            <p className="text-[#8B9BB0] leading-relaxed">
              This platform never places orders, never connects to broker trade
              APIs, and enforces{' '}
              <span className="font-mono text-[#CBD5E1]">
                orderExecutionEnabled=false
              </span>
              .
            </p>
          </div>
          <div className="p-5 space-y-1.5">
            <h3 className="font-medium text-[#E2E8F0]">
              No Synthetic or AI-Fabricated Calls
            </h3>
            <p className="text-[#8B9BB0] leading-relaxed">
              Future signals must be produced deterministically by validated
              server-side rule code on closed candles—never guessed by an LLM or
              scraped from chart DOM.
            </p>
          </div>
          <div className="p-5 space-y-1.5">
            <h3 className="font-medium text-[#E2E8F0]">
              Zero Fabricated Performance Metrics
            </h3>
            <p className="text-[#8B9BB0] leading-relaxed">
              Win rates, P&amp;L curves, entry prices, stop losses, and targets
              remain absent until verified replay backtesting and live feeds are
              approved in later milestones.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
