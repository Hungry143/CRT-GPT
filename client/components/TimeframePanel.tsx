'use client';

import type { SystemStatusResponse } from '@/shared/contracts/api';
import { TIMEFRAME_DEFINITIONS } from '@/shared/architecture';
import { deriveTimeframeRows } from '@/shared/utils/display';

interface TimeframePanelProps {
  systemStatus: SystemStatusResponse | null;
}

const DEFAULT_UNCONFIGURED_FEED = {
  state: 'NOT_CONFIGURED' as const,
  provider: null,
  symbol: null,
  lastTickAtUtc: null,
  lastClosedBarAtUtc: null,
  quality: 'UNAVAILABLE' as const,
};

export function TimeframePanel({ systemStatus }: TimeframePanelProps) {
  const rows = deriveTimeframeRows(
    systemStatus?.marketFeed ?? DEFAULT_UNCONFIGURED_FEED
  );

  return (
    <section
      aria-labelledby="timeframe-panel-heading"
      className="bg-[#111720] border border-[#222D3D] rounded-lg flex flex-col"
    >
      <div className="px-5 py-3.5 border-b border-[#1F2937] flex items-center justify-between gap-2">
        <div>
          <h2
            id="timeframe-panel-heading"
            className="font-display text-sm font-semibold text-[#F8FAFC]"
          >
            Timeframe Structure
          </h2>
          <p className="text-xs text-[#8B9BB0] mt-0.5">
            XAUUSD multi-timeframe readiness matrix
          </p>
        </div>
        <span className="font-mono text-xs text-[#8B9BB0] whitespace-nowrap">
          No active bias
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-[#1F2937] bg-[#0E131B] text-[#8B9BB0]">
              <th scope="col" className="py-2.5 pl-5 pr-3 font-medium">
                TF
              </th>
              <th scope="col" className="py-2.5 px-3 font-medium">
                Role
              </th>
              <th scope="col" className="py-2.5 px-3 font-medium">
                Feed Status
              </th>
              <th scope="col" className="py-2.5 pl-3 pr-5 font-medium text-right">
                Bias
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1A2230]">
            {rows.map((row) => (
              <tr
                key={row.timeframe}
                className={
                  row.enabled
                    ? 'hover:bg-[#151D29]/60 transition-colors'
                    : 'bg-[#0C1017] text-[#64748B]'
                }
              >
                <td className="py-2.5 pl-5 pr-3 font-mono font-semibold tabular-nums">
                  <span
                    className={
                      row.enabled ? 'text-[#F8FAFC]' : 'text-[#64748B]'
                    }
                  >
                    {row.timeframe}
                  </span>
                </td>
                <td className="py-2.5 px-3 font-mono text-[11px]">
                  <span
                    className={
                      row.role === 'HTF'
                        ? 'text-amber-300/90'
                        : row.role === 'LTF'
                          ? 'text-[#CBD5E1]'
                          : 'text-[#64748B]'
                    }
                  >
                    {row.role === 'FUTURE' ? 'Future' : row.role}
                  </span>
                </td>
                <td className="py-2.5 px-3">
                  <span
                    className={
                      row.enabled ? 'text-[#94A3B8]' : 'text-[#64748B] italic'
                    }
                  >
                    {row.statusLabel}
                  </span>
                </td>
                <td className="py-2.5 pl-3 pr-5 font-mono tabular-nums text-right text-[#64748B]">
                  {row.biasLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-5 py-3.5 border-t border-[#1F2937] bg-[#0E131B] rounded-b-lg grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px] leading-relaxed">
        <div>
          <p className="font-medium text-[#CBD5E1]">
            {TIMEFRAME_DEFINITIONS.HTF.name}
          </p>
          <p className="mt-1 text-[#8B9BB0]">
            {TIMEFRAME_DEFINITIONS.HTF.description}
          </p>
        </div>
        <div>
          <p className="font-medium text-[#CBD5E1]">
            {TIMEFRAME_DEFINITIONS.LTF.name}
          </p>
          <p className="mt-1 text-[#8B9BB0]">
            {TIMEFRAME_DEFINITIONS.LTF.description}
          </p>
        </div>
      </div>
    </section>
  );
}
