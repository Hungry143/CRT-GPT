'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  fetchAllDiagnostics,
  type DiagnosticsSnapshot,
} from '@/client/services/apiClient';
import { SidebarNav, type NavSectionId } from '@/client/components/SidebarNav';
import { TopStatusBar } from '@/client/components/TopStatusBar';
import { CommandCenterView } from '@/client/pages/CommandCenterView';
import { InstrumentAnalysisView } from '@/client/pages/InstrumentAnalysisView';
import { SignalsView } from '@/client/pages/SignalsView';
import { ResearchJournalView } from '@/client/pages/ResearchJournalView';
import { SystemHealthView } from '@/client/pages/SystemHealthView';
import { getUniverseInstrument, type InstrumentKey } from '@/shared/tradingSystem/universe';

interface AppShellProps {
  initialDiagnostics: DiagnosticsSnapshot;
  initialServerTimeUtc: string;
  initialSection?: NavSectionId;
}

export function AppShell({
  initialDiagnostics,
  initialServerTimeUtc,
  initialSection = 'command-center',
}: AppShellProps) {
  const [activeSection, setActiveSection] =
    useState<NavSectionId>(initialSection);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [diagnostics, setDiagnostics] =
    useState<DiagnosticsSnapshot>(initialDiagnostics);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedInstrument, setSelectedInstrument] = useState<InstrumentKey>('XAUUSD');
  const chartSymbol = getUniverseInstrument(selectedInstrument).chartSymbol;

  const refreshDiagnostics = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const next = await fetchAllDiagnostics();
      setDiagnostics(next);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Perform a live client-side verification against the real /api/* endpoints on mount
  useEffect(() => {
    const controller = new AbortController();
    fetchAllDiagnostics(controller.signal)
      .then((liveSnapshot) => {
        if (!controller.signal.aborted) {
          setDiagnostics(liveSnapshot);
        }
      })
      .catch(() => {
        // Errors are captured inside fetchAllDiagnostics results
      });
    return () => controller.abort();
  }, []);

  const handleSelectSection = useCallback((section: NavSectionId) => {
    setActiveSection(section);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (section === 'command-center') {
        url.searchParams.delete('view');
      } else {
        url.searchParams.set('view', section);
      }
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  const apiReachable =
    diagnostics.health.ok && diagnostics.systemStatus.ok;

  return (
    <div className="min-h-screen bg-[#0B0F14] text-[#E6EDF5] flex">
      <SidebarNav
        activeSection={activeSection}
        onSelectSection={handleSelectSection}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopStatusBar
          activeSection={activeSection}
          systemStatus={diagnostics.systemStatus.data}
          apiReachable={apiReachable}
          initialServerTimeUtc={initialServerTimeUtc}
          isRefreshing={isRefreshing}
          onRefresh={refreshDiagnostics}
          selectedInstrument={selectedInstrument}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 px-4 sm:px-6 py-5 lg:py-6 max-w-[1440px] w-full mx-auto">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeSection}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            >
              {activeSection === 'command-center' && (
                <CommandCenterView
                  selectedInstrument={selectedInstrument}
                  onSelectInstrument={setSelectedInstrument}
                  chartSymbol={chartSymbol}
                  diagnostics={diagnostics}
                  isLoading={isRefreshing}
                />
              )}
              {activeSection === 'instrument-analysis' && (
                <InstrumentAnalysisView diagnostics={diagnostics} selectedInstrument={selectedInstrument} onSelectInstrument={setSelectedInstrument} chartSymbol={chartSymbol} />
              )}
              {activeSection === 'signals' && (
                <SignalsView diagnostics={diagnostics} />
              )}
              {activeSection === 'research-journal' && <ResearchJournalView />}
              {activeSection === 'system-health' && (
                <SystemHealthView
                  diagnostics={diagnostics}
                  isRefreshing={isRefreshing}
                  onRefresh={refreshDiagnostics}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>

        <footer className="border-t border-[#1F2937] px-4 sm:px-6 py-3 text-[11px] text-[#64748B] flex flex-wrap items-center justify-between gap-2">
          <span>
            CRT Intelligence · 14-Market Signal-Only Platform (foundation)
          </span>
          <span>Signal-only architecture · Order execution disabled</span>
        </footer>
      </div>
    </div>
  );
}
