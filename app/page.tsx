import { AppShell } from '@/client/components/AppShell';
import type { DiagnosticsSnapshot } from '@/client/services/apiClient';
import { buildHealthPayload } from '@/server/routes/health';
import { buildInstrumentsPayload } from '@/server/routes/instruments';
import { buildSignalsPayload } from '@/server/routes/signals';
import { buildSystemStatusPayload } from '@/server/routes/systemStatus';

import type { NavSectionId } from '@/client/components/SidebarNav';

export const dynamic = 'force-dynamic';

const VALID_SECTIONS = new Set<NavSectionId>([
  'command-center',
  'instrument-analysis',
  'signals',
  'research-journal',
  'system-health',
]);

interface HomePageProps {
  searchParams?: Promise<{ view?: string | string[] }>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const resolvedParams = searchParams ? await searchParams : undefined;
  const rawView = Array.isArray(resolvedParams?.view)
    ? resolvedParams?.view[0]
    : resolvedParams?.view;
  const initialSection: NavSectionId =
    rawView && VALID_SECTIONS.has(rawView as NavSectionId)
      ? (rawView as NavSectionId)
      : 'command-center';

  const now = new Date();
  const checkedAtUtc = now.toISOString();

  const initialDiagnostics: DiagnosticsSnapshot = {
    health: {
      endpoint: '/api/health',
      ok: true,
      httpStatus: 200,
      data: buildHealthPayload(now),
      error: null,
      checkedAtUtc,
    },
    systemStatus: {
      endpoint: '/api/system/status',
      ok: true,
      httpStatus: 200,
      data: buildSystemStatusPayload(now),
      error: null,
      checkedAtUtc,
    },
    instruments: {
      endpoint: '/api/instruments',
      ok: true,
      httpStatus: 200,
      data: buildInstrumentsPayload(now),
      error: null,
      checkedAtUtc,
    },
    signals: {
      endpoint: '/api/signals',
      ok: true,
      httpStatus: 200,
      data: buildSignalsPayload(),
      error: null,
      checkedAtUtc,
    },
  };

  return (
    <AppShell
      initialDiagnostics={initialDiagnostics}
      initialServerTimeUtc={checkedAtUtc}
      initialSection={initialSection}
    />
  );
}
