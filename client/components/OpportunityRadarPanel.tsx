'use client';

import { ShieldOff } from 'lucide-react';
import type { SignalsResponse, SystemStatusResponse } from '@/shared/contracts/api';
import { deriveConfirmedSignalCount } from '@/shared/utils/display';

interface OpportunityRadarPanelProps {
  signalsResponse: SignalsResponse | null;
  systemStatus: SystemStatusResponse | null;
  compact?: boolean;
}

const SIGNAL_STAGES = [
  {
    key: 'forming' as const,
    title: 'Forming',
    subtitle: 'HTF range setup in progress',
    description:
      'Reserved for early structural range development once verified candles and validated CRT rules are active.',
  },
  {
    key: 'pending' as const,
    title: 'Pending',
    subtitle: 'Sweep observed, awaiting LTF confirmation',
    description:
      'Reserved for candidate setups where a higher-timeframe level has been tested and lower-timeframe confirmation is pending.',
  },
  {
    key: 'confirmed' as const,
    title: 'Confirmed',
    subtitle: 'All source-validated criteria satisfied',
    description:
      'Reserved for discretionary review signals meeting every auditable rule check. Never triggers automated order execution.',
  },
] as const;

export function OpportunityRadarPanel({
  signalsResponse,
  systemStatus,
  compact = false,
}: OpportunityRadarPanelProps) {
  const signals = signalsResponse?.data ?? [];
  const confirmedCount = systemStatus
    ? deriveConfirmedSignalCount(systemStatus.marketFeed, signals)
    : 0;

  return (
    <section
      aria-labelledby="opportunity-radar-heading"
      className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
    >
      <div className="px-5 py-3.5 border-b border-[#1F2937] flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            id="opportunity-radar-heading"
            className="font-display text-sm font-semibold text-[#F8FAFC]"
          >
            Opportunity Radar
          </h2>
          <p className="text-xs text-[#8B9BB0] mt-0.5">
            Discretionary signal lifecycle tracks (XAUUSD)
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-[#8B9BB0]">
          <span>State: {signalsResponse?.state ?? 'ENGINE_DISABLED'}</span>
          <span aria-hidden="true">·</span>
          <span>Confirmed: {confirmedCount}</span>
        </div>
      </div>

      <div className="px-5 py-4 border-b border-[#1F2937] bg-[#0E131B] flex items-start gap-3">
        <ShieldOff
          className="h-4 w-4 text-amber-400 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="text-xs">
          <p className="font-medium text-[#F8FAFC]">
            No signals — CRT engine not enabled
          </p>
          <p className="mt-1 text-[#8B9BB0] leading-relaxed">
            Stage 1 operates strictly in foundation and diagnostics mode. No
            entry prices, stop losses, targets, confidence scores, or simulated
            alerts are generated.
          </p>
        </div>
      </div>

      <div
        className={`grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#1F2937] ${
          compact ? '' : 'min-h-[220px]'
        }`}
      >
        {SIGNAL_STAGES.map((stage) => {
          const stageCount = signals.filter((s) => s.state === stage.key).length;
          return (
            <div key={stage.key} className="p-5 flex flex-col justify-between gap-4">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold text-[#E2E8F0]">
                    {stage.title}
                  </h3>
                  <span className="font-mono text-xs tabular-nums text-[#64748B]">
                    {stageCount}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[#94A3B8]">{stage.subtitle}</p>
                {!compact && (
                  <p className="mt-2.5 text-xs leading-relaxed text-[#64748B]">
                    {stage.description}
                  </p>
                )}
              </div>

              <div className="pt-3 border-t border-[#1A2230] flex items-center justify-between text-xs">
                <span className="text-[#64748B]">No data yet</span>
                <span className="font-mono text-[#475569]">—</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
