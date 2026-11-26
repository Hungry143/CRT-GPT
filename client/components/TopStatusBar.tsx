'use client';

import { useEffect, useState } from 'react';
import { Menu, RefreshCw } from 'lucide-react';
import type { SystemStatusResponse } from '@/shared/contracts/api';
import {
  formatEngineStateLabel,
  formatFeedStateLabel,
} from '@/shared/utils/display';
import {
  formatKolkataClock,
  formatNewYorkClock,
  getTimeZoneShortName,
  MARKET_REFERENCE_TIMEZONE,
} from '@/shared/utils/time';
import { NAV_ITEMS, type NavSectionId } from '@/client/components/SidebarNav';
import type { InstrumentKey } from '@/shared/tradingSystem/universe';

interface TopStatusBarProps {
  activeSection: NavSectionId;
  systemStatus: SystemStatusResponse | null;
  apiReachable: boolean;
  initialServerTimeUtc: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  onOpenMobileNav: () => void;
  selectedInstrument: InstrumentKey;
}

export function TopStatusBar({
  activeSection,
  systemStatus,
  apiReachable,
  initialServerTimeUtc,
  isRefreshing,
  onRefresh,
  onOpenMobileNav,
  selectedInstrument,
}: TopStatusBarProps) {
  const [clockInstant, setClockInstant] = useState<string>(initialServerTimeUtc);

  useEffect(() => {
    const syncClock = () => setClockInstant(new Date().toISOString());
    const initTimer = setTimeout(syncClock, 0);
    const interval = setInterval(syncClock, 1000);
    return () => {
      clearTimeout(initTimer);
      clearInterval(interval);
    };
  }, []);

  const nyClock = formatNewYorkClock(clockInstant);
  const nyShort = getTimeZoneShortName(clockInstant, MARKET_REFERENCE_TIMEZONE);
  const istClock = formatKolkataClock(clockInstant);

  const activeNav = NAV_ITEMS.find((item) => item.id === activeSection);
  const feedLabel = !apiReachable
    ? 'API unreachable'
    : systemStatus?.marketFeed.state === 'NOT_CONFIGURED'
      ? 'Not connected'
      : systemStatus
        ? formatFeedStateLabel(systemStatus.marketFeed.state)
        : 'Not connected';

  const engineLabel = systemStatus
    ? formatEngineStateLabel(systemStatus.crtEngine.state)
    : 'Disabled';

  const riskLabel =
    systemStatus?.riskMode === 'RESEARCH_ONLY' || !systemStatus
      ? 'Research-only'
      : systemStatus.riskMode;

  return (
    <>
      <header className="sticky top-0 z-30 h-14 bg-[#0B0F14]/95 backdrop-blur-sm border-b border-[#1F2937] px-4 lg:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0 shrink-0">
          <button
            type="button"
            onClick={onOpenMobileNav}
            aria-label="Open navigation menu"
            className="lg:hidden inline-flex h-10 w-10 items-center justify-center rounded-md text-[#CBD5E1] hover:bg-[#161E29] hover:text-[#F8FAFC] focus-visible:outline-2 focus-visible:outline-amber-500 shrink-0"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <span className="lg:hidden font-display text-[15px] font-semibold tracking-tight text-[#F8FAFC] whitespace-nowrap">
            CRT Intelligence
          </span>
          <h1 className="hidden lg:block font-display text-[15px] font-semibold text-[#F8FAFC] whitespace-nowrap">
            {activeNav?.label ?? 'Command Center'}
          </h1>
        </div>

        <div className="hidden xl:flex items-center gap-3.5 text-xs">
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Feed</span>
            <span
              className={`font-medium ${
                !apiReachable ? 'text-red-400' : 'text-amber-300'
              }`}
            >
              {feedLabel}
            </span>
          </div>
          <span className="h-3.5 w-px bg-[#222D3D]" aria-hidden="true" />
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Engine</span>
            <span className="font-medium text-[#CBD5E1]">{engineLabel}</span>
          </div>
          <span className="h-3.5 w-px bg-[#222D3D]" aria-hidden="true" />
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Mode</span>
            <span className="font-medium text-[#CBD5E1]">{riskLabel}</span>
          </div>
          <span className="h-3.5 w-px bg-[#222D3D]" aria-hidden="true" />
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Instrument</span>
            <span className="font-mono font-semibold text-amber-400">
              {selectedInstrument}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div
            className="hidden sm:flex items-center gap-3 text-xs font-mono tabular-nums"
            aria-label="Market reference and local clocks"
          >
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-[#8B9BB0] font-sans">NY</span>
              <span
                className="text-[#E2E8F0]"
                data-testid="clock-ny"
                title={nyClock.fullLabel}
              >
                {nyClock.timeLabel}
              </span>
              <span className="text-[#64748B]">{nyShort}</span>
            </div>
            <span className="h-3.5 w-px bg-[#222D3D]" aria-hidden="true" />
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-[#8B9BB0] font-sans">IST</span>
              <span
                className="text-[#E2E8F0]"
                data-testid="clock-ist"
                title={istClock.fullLabel}
              >
                {istClock.timeLabel}
              </span>
              <span className="text-[#64748B]">IST</span>
            </div>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label="Refresh system status"
            className="inline-flex h-9 items-center gap-1.5 px-3 rounded-md border border-[#243042] bg-[#111720] text-xs font-medium text-[#CBD5E1] hover:bg-[#18212E] hover:text-[#F8FAFC] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span className="hidden md:inline">Refresh</span>
          </button>
        </div>
      </header>

      {/* Non-sticky status strip for viewports below xl so sticky header stays compact (56px) on mobile */}
      <div className="xl:hidden border-b border-[#1F2937] bg-[#0E131B] px-4 py-2.5 text-xs space-y-2">
        <div className="lg:hidden flex items-center justify-between gap-2 pb-1.5 border-b border-[#1F2937]">
          <h1 className="font-display text-sm font-semibold text-[#F8FAFC]">
            {activeNav?.label ?? 'Command Center'}
          </h1>
          <span className="font-mono text-xs font-semibold text-amber-400">
            XAUUSD
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="hidden lg:flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Instrument:</span>
            <span className="font-mono font-semibold text-amber-400">
              XAUUSD
            </span>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Data Feed:</span>
            <span
              className={`font-medium ${
                !apiReachable ? 'text-red-400' : 'text-amber-300'
              }`}
            >
              {feedLabel}
            </span>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Engine:</span>
            <span className="font-medium text-[#CBD5E1]">{engineLabel}</span>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[#8B9BB0]">Signal Mode:</span>
            <span className="font-medium text-[#CBD5E1]">{riskLabel}</span>
          </div>
          <div className="sm:hidden flex items-center gap-3 font-mono tabular-nums text-[#CBD5E1] w-full pt-1.5 border-t border-[#1F2937]">
            <span>
              <span className="text-[#8B9BB0] font-sans mr-1">NY</span>
              {nyClock.timeLabel} {nyShort}
            </span>
            <span className="text-[#475569]" aria-hidden="true">
              ·
            </span>
            <span>
              <span className="text-[#8B9BB0] font-sans mr-1">IST</span>
              {istClock.timeLabel} IST
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
