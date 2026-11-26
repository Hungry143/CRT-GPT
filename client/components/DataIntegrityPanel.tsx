'use client';

import type {
  MarketSessionResponse,
  MarketStatusResponse,
} from '@/shared/contracts/marketData';
import { NO_DATA_DASH } from '@/shared/utils/display';

interface DataIntegrityPanelProps {
  marketStatus: MarketStatusResponse | null;
  marketSession: MarketSessionResponse | null;
}

export function DataIntegrityPanel({
  marketStatus,
  marketSession,
}: DataIntegrityPanelProps) {
  const quality = marketStatus?.quality ?? null;
  const session = marketSession?.session ?? null;

  const nextH4 = session?.nextBoundaries.find((b) => b.granularity === 'H4');
  const nextD1 = session?.nextBoundaries.find((b) => b.granularity === 'D1');

  const freshnessDisplay =
    quality && quality.freshnessSeconds !== null
      ? `${quality.freshnessSeconds}s`
      : NO_DATA_DASH;

  const gapsDisplay =
    quality && quality.missingBarCount !== null
      ? String(quality.missingBarCount)
      : NO_DATA_DASH;

  const duplicatesDisplay =
    quality && quality.duplicateBarCount !== null
      ? String(quality.duplicateBarCount)
      : NO_DATA_DASH;

  const historyLabel =
    marketStatus?.historyPersistence === 'NOT_PERSISTENT' || !marketStatus
      ? 'History: NOT_PERSISTENT'
      : `History: ${marketStatus.historyPersistence}`;

  return (
    <section
      aria-labelledby="data-integrity-heading"
      className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
    >
      <div className="px-5 py-3.5 border-b border-[#1F2937] flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            id="data-integrity-heading"
            className="font-display text-sm font-semibold text-[#F8FAFC]"
          >
            Data Integrity &amp; Session Policy
          </h2>
          <p className="text-xs text-[#8B9BB0] mt-0.5">
            Stage 2A read-only adapter telemetry, candle audit counters, and DST
            anchor state
          </p>
        </div>
        <span className="font-mono text-xs text-amber-300 whitespace-nowrap">
          {historyLabel}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-[#1F2937] text-xs">
        <dl className="px-5 py-2 divide-y divide-[#1A2230]">
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Feed Adapter Status</dt>
            <dd className="font-mono text-amber-300 text-right">
              {marketStatus
                ? `${marketStatus.adapterName} · ${marketStatus.quality.state}`
                : 'NoProviderAdapter · NOT_CONFIGURED'}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Provider Verified</dt>
            <dd className="font-mono text-[#E2E8F0]">
              {marketStatus?.providerVerified ? 'Yes' : 'No'}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Last Completed Candle (UTC)</dt>
            <dd className="font-mono tabular-nums text-[#E2E8F0]">
              {quality?.lastCompleteCandleCloseUtc ?? NO_DATA_DASH}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Freshness</dt>
            <dd className="font-mono tabular-nums text-[#E2E8F0]">
              {freshnessDisplay}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Bar Gaps / Duplicates</dt>
            <dd className="font-mono tabular-nums text-[#E2E8F0]">
              {gapsDisplay} / {duplicatesDisplay}
            </dd>
          </div>
        </dl>

        <dl className="px-5 py-2 divide-y divide-[#1A2230]">
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Session / DST Status</dt>
            <dd className="font-mono tabular-nums text-[#E2E8F0] text-right">
              {session
                ? `${session.nyAbbreviation} (${session.nyOffset}) · ${session.isDstActive ? 'DST active' : 'Standard time'}`
                : NO_DATA_DASH}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Daily Roll Anchor</dt>
            <dd className="font-mono text-[#CBD5E1] text-right">
              {session
                ? `${String(session.alignmentPolicy.dailyRollHourNy).padStart(2, '0')}:00 ${session.alignmentPolicy.alignmentTimezone}`
                : '17:00 America/New_York'}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Next H4 Boundary (NY)</dt>
            <dd className="font-mono tabular-nums text-[#CBD5E1] text-right">
              {nextH4 ? nextH4.nextBoundaryNyLocal : NO_DATA_DASH}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Next D1 Boundary (NY)</dt>
            <dd className="font-mono tabular-nums text-[#CBD5E1] text-right">
              {nextD1 ? nextD1.nextBoundaryNyLocal : NO_DATA_DASH}
            </dd>
          </div>
          <div className="py-2.5 flex items-center justify-between gap-4">
            <dt className="text-[#8B9BB0]">Historical Persistence</dt>
            <dd className="font-mono text-amber-300 text-right">
              {marketStatus?.historyPersistence ?? 'NOT_PERSISTENT'}
            </dd>
          </div>
        </dl>
      </div>

      <div className="px-5 py-2.5 border-t border-[#1F2937] bg-[#0E131B] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8B9BB0]">
        <span>
          Schedule vs Observed:{' '}
          <span className="font-mono text-[#CBD5E1]">
            {session?.expectedMarketScheduleState ?? 'UNKNOWN'}
          </span>{' '}
          /{' '}
          <span className="font-mono text-[#CBD5E1]">
            {session?.observedMarketAvailability ?? 'UNOBSERVED_NO_FEED'}
          </span>
        </span>
        <span>
          H4 NY anchors: 17:00, 21:00, 01:00, 05:00, 09:00, 13:00 · Backfill
          disabled by default
        </span>
      </div>
    </section>
  );
}
