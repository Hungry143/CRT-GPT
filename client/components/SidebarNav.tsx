'use client';

import {
  Activity,
  BookOpen,
  CandlestickChart,
  LayoutDashboard,
  Radio,
  X,
} from 'lucide-react';
import type { ComponentType } from 'react';

export type NavSectionId =
  | 'command-center'
  | 'instrument-analysis'
  | 'signals'
  | 'research-journal'
  | 'system-health';

export interface NavItemSpec {
  id: NavSectionId;
  label: string;
  shortLabel: string;
  icon: ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: readonly NavItemSpec[] = [
  {
    id: 'command-center',
    label: 'Command Center',
    shortLabel: 'Command',
    icon: LayoutDashboard,
  },
  {
    id: 'instrument-analysis',
    label: 'Instrument Analysis',
    shortLabel: 'Instrument',
    icon: CandlestickChart,
  },
  {
    id: 'signals',
    label: 'Signals',
    shortLabel: 'Signals',
    icon: Radio,
  },
  {
    id: 'research-journal',
    label: 'Research & Journal',
    shortLabel: 'Research',
    icon: BookOpen,
  },
  {
    id: 'system-health',
    label: 'System Health',
    shortLabel: 'Health',
    icon: Activity,
  },
] as const;

interface SidebarNavProps {
  activeSection: NavSectionId;
  onSelectSection: (section: NavSectionId) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function SidebarNav({
  activeSection,
  onSelectSection,
  mobileOpen,
  onCloseMobile,
}: SidebarNavProps) {
  const handleSelect = (id: NavSectionId) => {
    onSelectSection(id);
    onCloseMobile();
  };

  const navContent = (
    <div className="flex h-full flex-col bg-[#0E131B] border-r border-[#1F2937]">
      <div className="flex h-14 items-center justify-between px-5 border-b border-[#1F2937]">
        <div className="min-w-0">
          <span className="font-display text-[15px] font-semibold tracking-tight text-[#F8FAFC] whitespace-nowrap">
            CRT Intelligence
          </span>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation menu"
          className="lg:hidden inline-flex h-9 w-9 items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#161E29] hover:text-[#F8FAFC] focus-visible:outline-2 focus-visible:outline-amber-500"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="px-5 py-3 border-b border-[#1F2937]">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[#8B9BB0]">Instrument Universe</span>
          <span className="font-mono font-medium text-amber-400 tabular-nums">
            14 markets
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-[#64748B]">
          Discretionary signal-only research shell. No broker execution.
        </p>
      </div>

      <nav aria-label="Primary navigation" className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelect(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left text-sm font-medium transition-colors duration-150 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-amber-500 ${
                isActive
                  ? 'bg-[#18212E] text-[#F8FAFC] ring-1 ring-inset ring-[#2A374A]'
                  : 'text-[#94A3B8] hover:bg-[#141C27] hover:text-[#E2E8F0]'
              }`}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${
                  isActive ? 'text-amber-400' : 'text-[#64748B]'
                }`}
                aria-hidden="true"
              />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-[#1F2937] text-xs text-[#64748B] space-y-1">
        <div className="flex items-center justify-between">
          <span>Milestone</span>
          <span className="font-mono text-[#94A3B8]">Platform build</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Order Execution</span>
          <span className="font-mono text-[#94A3B8]">Disabled</span>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block lg:w-60 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen">
        {navContent}
      </aside>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 flex lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          <button
            type="button"
            aria-label="Close navigation backdrop"
            onClick={onCloseMobile}
            className="fixed inset-0 bg-black/70"
          />
          <div className="relative z-10 w-64 max-w-[82vw] h-full">
            {navContent}
          </div>
        </div>
      )}
    </>
  );
}
