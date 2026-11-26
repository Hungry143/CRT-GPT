'use client';

import { PLANNED_ARCHITECTURE_MODULES } from '@/shared/architecture';

export function ResearchJournalView() {
  return (
    <div className="space-y-6">
      <section
        aria-labelledby="research-welcome-heading"
        className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-[#1F2937] flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              id="research-welcome-heading"
              className="font-display text-base font-semibold text-[#F8FAFC]"
            >
              Research &amp; Journal — Stage 1 Foundation
            </h2>
            <p className="text-xs text-[#8B9BB0] mt-0.5">
              Read-only research protocol · XAUUSD discretionary CRT study
            </p>
          </div>
          <span className="font-mono text-xs text-[#8B9BB0]">Read-only</span>
        </div>

        <article className="p-5 sm:p-6 max-w-3xl space-y-5 text-sm leading-relaxed text-[#CBD5E1]">
          <div className="space-y-2">
            <h3 className="font-display text-sm font-semibold text-[#F8FAFC]">
              1. Research Inputs Before Rule Implementation
            </h3>
            <p className="text-[#94A3B8]">
              CRT source documents, annotated chart studies, and session notes
              are treated strictly as research inputs. Source-specific CRT
              detection rules will only be encoded into the backend engine after
              each definition has been independently reviewed, documented, and
              validated against clean historical OHLC data.
            </p>
          </div>

          <div className="pt-4 border-t border-[#1F2937] space-y-2">
            <h3 className="font-display text-sm font-semibold text-[#F8FAFC]">
              2. Journal Entry Policy (Stage 1)
            </h3>
            <p className="text-[#94A3B8]">
              No simulated trades, hypothetical win rates, or mock journal
              entries are seeded in this workspace. Once Stage 2 market data and
              Stage 3 rule validation are completed, discretionary trade notes
              and replay audit logs will record strictly UTC-timestamped
              observations.
            </p>
          </div>

          <div className="pt-4 border-t border-[#1F2937] space-y-2">
            <h3 className="font-display text-sm font-semibold text-[#F8FAFC]">
              3. Markdown Research Scratchpad Placeholder
            </h3>
            <div className="rounded-md border border-[#1F2937] bg-[#0B0F14] p-4 font-mono text-xs text-[#94A3B8] space-y-1.5 leading-relaxed">
              <p className="text-[#E2E8F0]"># XAUUSD CRT Research Dossier</p>
              <p>Status: Stage 1 Foundation (No validated rules loaded)</p>
              <p>Primary Scope: XAUUSD · D1 / H4 (HTF) and H1 / M15 (LTF)</p>
              <p>Reference Clocks: UTC ISO-8601 storage · America/New_York · Asia/Kolkata</p>
              <p>Pending Gate: Source document ingestion &amp; verified MarketDataAdapter</p>
            </div>
          </div>
        </article>
      </section>

      <section
        aria-labelledby="planned-architecture-heading"
        className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-[#1F2937] flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              id="planned-architecture-heading"
              className="font-display text-sm font-semibold text-[#F8FAFC]"
            >
              Planned Backend Module Roadmap
            </h2>
            <p className="text-xs text-[#8B9BB0] mt-0.5">
              Documented boundaries for future milestones — none implemented in
              Stage 1
            </p>
          </div>
          <span className="font-mono text-xs text-[#64748B]">
            8 planned modules
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#1F2937] bg-[#0E131B] text-[#8B9BB0]">
                <th scope="col" className="py-2.5 pl-5 pr-3 font-medium">
                  Module
                </th>
                <th scope="col" className="py-2.5 px-3 font-medium">
                  Target
                </th>
                <th scope="col" className="py-2.5 px-3 font-medium">
                  Intended Responsibility
                </th>
                <th scope="col" className="py-2.5 pl-3 pr-5 font-medium text-right">
                  Stage 1 Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1A2230]">
              {PLANNED_ARCHITECTURE_MODULES.map((mod) => (
                <tr key={mod.id} className="hover:bg-[#151D29]/50">
                  <td className="py-3 pl-5 pr-3 font-mono font-medium text-[#E2E8F0] whitespace-nowrap">
                    {mod.id}
                  </td>
                  <td className="py-3 px-3 font-mono text-[#94A3B8] whitespace-nowrap">
                    {mod.stage}
                  </td>
                  <td className="py-3 px-3 text-[#94A3B8] leading-relaxed min-w-[260px]">
                    {mod.responsibility}
                  </td>
                  <td className="py-3 pl-3 pr-5 font-mono text-[#64748B] text-right whitespace-nowrap">
                    Not implemented
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
