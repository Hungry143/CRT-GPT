'use client';

import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import type { DiagnosticsSnapshot } from '@/client/services/apiClient';
import { DataIntegrityPanel } from '@/client/components/DataIntegrityPanel';
import { NO_DATA_DASH } from '@/shared/utils/display';
import { formatKolkataClock, formatNewYorkClock } from '@/shared/utils/time';

interface SystemHealthViewProps {
  diagnostics: DiagnosticsSnapshot;
  isRefreshing: boolean;
  onRefresh: () => void;
}

export function SystemHealthView({
  diagnostics,
  isRefreshing,
  onRefresh,
}: SystemHealthViewProps) {
  const {
    health,
    systemStatus,
    instruments,
    signals,
    marketStatus,
    marketCandles,
    marketSession,
  } = diagnostics;
  const allOk =
    health.ok &&
    systemStatus.ok &&
    instruments.ok &&
    signals.ok &&
    marketStatus.ok &&
    marketCandles.ok &&
    marketSession.ok;
  const anyDown = !allOk;

  const endpointRows = [
    {
      path: 'GET /api/health',
      result: health,
      summary: health.data
        ? `${health.data.service} v${health.data.version} (${health.data.status})`
        : health.error ?? 'Unavailable',
    },
    {
      path: 'GET /api/system/status',
      result: systemStatus,
      summary: systemStatus.data
        ? `feed=${systemStatus.data.marketFeed.state} · engine=${systemStatus.data.crtEngine.state}`
        : systemStatus.error ?? 'Unavailable',
    },
    {
      path: 'GET /api/instruments',
      result: instruments,
      summary: instruments.data
        ? `${instruments.data.data.length} config-only instrument (${instruments.data.data[0]?.key ?? '—'})`
        : instruments.error ?? 'Unavailable',
    },
    {
      path: 'GET /api/signals',
      result: signals,
      summary: signals.data
        ? `${signals.data.data.length} signals (${signals.data.state})`
        : signals.error ?? 'Unavailable',
    },
    {
      path: 'GET /api/market/status',
      result: marketStatus,
      summary: marketStatus.data
        ? `${marketStatus.data.adapterName} · ${marketStatus.data.quality.state} · ${marketStatus.data.historyPersistence}`
        : marketStatus.error ?? 'Unavailable',
    },
    {
      path: 'GET /api/market/candles',
      result: marketCandles,
      summary: marketCandles.data
        ? `${marketCandles.data.count} completed bars (${marketCandles.data.status})`
        : marketCandles.error ?? 'Unavailable',
    },
    {
      path: 'GET /api/market/session',
      result: marketSession,
      summary: marketSession.data
        ? `${marketSession.data.session.nyAbbreviation} (${marketSession.data.session.nyOffset}) · ${marketSession.data.session.observedMarketAvailability}`
        : marketSession.error ?? 'Unavailable',
    },
  ];

  const serverTimeUtc =
    systemStatus.data?.serverTimeUtc ?? health.data?.serverTimeUtc ?? null;
  const nyFormatted = serverTimeUtc
    ? formatNewYorkClock(serverTimeUtc).fullLabel
    : NO_DATA_DASH;
  const istFormatted = serverTimeUtc
    ? formatKolkataClock(serverTimeUtc).fullLabel
    : NO_DATA_DASH;

  return (
    <div className="space-y-6">
      {anyDown ? (
        <div
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-950/30 px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className="h-5 w-5 text-red-400 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div className="text-xs leading-relaxed">
              <p className="font-display font-semibold text-red-100 text-sm">
                Backend diagnostics API failure detected
              </p>
              <p className="mt-1 text-red-200/90">
                One or more backend endpoints failed to respond or did not pass
                strict schema validation. Review individual endpoint diagnostics
                below.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="inline-flex h-9 items-center gap-1.5 px-4 rounded-md bg-red-500/20 border border-red-400/40 text-xs font-medium text-red-100 hover:bg-red-500/30 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-red-400"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>Retry diagnostics</span>
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-[#222D3D] bg-[#111720] px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <CheckCircle2
              className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div className="text-xs leading-relaxed">
              <p className="font-display font-semibold text-[#F8FAFC] text-sm">
                Diagnostics APIs Reachable
              </p>
              <p className="mt-0.5 text-[#94A3B8]">
                All 7 Stage 1 and Stage 2A backend contracts passed Zod schema
                verification. Market data feed and CRT engine remain
                intentionally disabled.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="inline-flex h-9 items-center gap-1.5 px-4 rounded-md border border-[#2A374A] bg-[#161E29] text-xs font-medium text-[#E2E8F0] hover:bg-[#1E293B] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-500"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>Refresh diagnostics</span>
          </button>
        </div>
      )}

      <DataIntegrityPanel
        marketStatus={marketStatus.data}
        marketSession={marketSession.data}
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-stretch">
        <section
          aria-labelledby="sys-config-heading"
          className="bg-[#111720] border border-[#222D3D] rounded-lg flex flex-col"
        >
          <div className="px-5 py-3.5 border-b border-[#1F2937]">
            <h2
              id="sys-config-heading"
              className="font-display text-sm font-semibold text-[#F8FAFC]"
            >
              Runtime &amp; Configuration Diagnostics
            </h2>
            <p className="text-xs text-[#8B9BB0] mt-0.5">
              Verified fields from /api/health and /api/system/status
            </p>
          </div>

          <dl className="px-5 py-2 divide-y divide-[#1A2230] text-xs flex-1">
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">Application Service</dt>
              <dd className="font-mono text-[#E2E8F0]">
                {health.data?.service ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">Application Version</dt>
              <dd className="font-mono tabular-nums text-[#E2E8F0]">
                {health.data?.version ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">Status Schema Version</dt>
              <dd className="font-mono tabular-nums text-[#E2E8F0]">
                {systemStatus.data?.schemaVersion ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">Environment</dt>
              <dd className="font-mono text-[#E2E8F0]">
                {systemStatus.data?.environment ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">Provider Configuration</dt>
              <dd className="font-mono text-amber-300">
                {systemStatus.data?.marketFeed.state ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">CRT Engine State</dt>
              <dd className="font-mono text-[#E2E8F0]">
                {systemStatus.data?.crtEngine.state ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">Risk Mode</dt>
              <dd className="font-mono text-[#E2E8F0]">
                {systemStatus.data?.riskMode ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-[#8B9BB0]">Order Execution Enabled</dt>
              <dd className="font-mono text-[#E2E8F0]">
                {systemStatus.data !== null
                  ? String(systemStatus.data.orderExecutionEnabled)
                  : NO_DATA_DASH}
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="sys-time-gates-heading"
          className="bg-[#111720] border border-[#222D3D] rounded-lg flex flex-col"
        >
          <div className="px-5 py-3.5 border-b border-[#1F2937]">
            <h2
              id="sys-time-gates-heading"
              className="font-display text-sm font-semibold text-[#F8FAFC]"
            >
              Server Timestamps &amp; Feature Gates
            </h2>
            <p className="text-xs text-[#8B9BB0] mt-0.5">
              Canonical UTC storage with DST-safe NY and IST conversions
            </p>
          </div>

          <dl className="px-5 py-2 divide-y divide-[#1A2230] text-xs flex-1">
            <div className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
              <dt className="text-[#8B9BB0]">Server Timestamp (UTC)</dt>
              <dd
                className="font-mono tabular-nums text-[#E2E8F0]"
                data-testid="health-server-utc"
              >
                {serverTimeUtc ?? NO_DATA_DASH}
              </dd>
            </div>
            <div className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
              <dt className="text-[#8B9BB0]">Market Reference (America/New_York)</dt>
              <dd className="font-mono tabular-nums text-[#CBD5E1]">
                {nyFormatted}
              </dd>
            </div>
            <div className="py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
              <dt className="text-[#8B9BB0]">User Clock (Asia/Kolkata)</dt>
              <dd className="font-mono tabular-nums text-[#CBD5E1]">
                {istFormatted}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="font-mono text-[#94A3B8]">MARKET_FEED_ENABLED</dt>
              <dd className="font-mono text-amber-300">false (Stage 1 locked)</dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="font-mono text-[#94A3B8]">CRT_ENGINE_ENABLED</dt>
              <dd className="font-mono text-amber-300">false (Stage 1 locked)</dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="font-mono text-[#94A3B8]">SIGNALS_ENABLED</dt>
              <dd className="font-mono text-amber-300">false (Stage 1 locked)</dd>
            </div>
          </dl>

          <div className="px-5 py-3 border-t border-[#1F2937] bg-[#0E131B] rounded-b-lg text-[11px] text-[#8B9BB0]">
            Feature gates are read-only server controls. Interactive toggles
            that falsely activate unconfigured services are intentionally
            omitted.
          </div>
        </section>
      </div>

      <section
        aria-labelledby="endpoint-matrix-heading"
        className="bg-[#111720] border border-[#222D3D] rounded-lg overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-[#1F2937]">
          <h2
            id="endpoint-matrix-heading"
            className="font-display text-sm font-semibold text-[#F8FAFC]"
          >
            API Endpoint Reachability
          </h2>
          <p className="text-xs text-[#8B9BB0] mt-0.5">
            Direct HTTP &amp; schema check results from the browser client
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#1F2937] bg-[#0E131B] text-[#8B9BB0]">
                <th scope="col" className="py-2.5 pl-5 pr-3 font-medium">
                  Endpoint
                </th>
                <th scope="col" className="py-2.5 px-3 font-medium">
                  Reachability
                </th>
                <th scope="col" className="py-2.5 px-3 font-medium">
                  HTTP
                </th>
                <th scope="col" className="py-2.5 pl-3 pr-5 font-medium">
                  Diagnostic Payload Summary
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1A2230]">
              {endpointRows.map((row) => (
                <tr key={row.path} className="hover:bg-[#151D29]/50">
                  <td className="py-3 pl-5 pr-3 font-mono font-medium text-[#E2E8F0] whitespace-nowrap">
                    {row.path}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    <span
                      className={
                        row.result.ok
                          ? 'text-emerald-400 font-medium'
                          : 'text-red-400 font-medium'
                      }
                    >
                      {row.result.ok ? 'Reachable' : 'Failed'}
                    </span>
                  </td>
                  <td className="py-3 px-3 font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                    {row.result.httpStatus ?? NO_DATA_DASH}
                  </td>
                  <td className="py-3 pl-3 pr-5 font-mono text-[#94A3B8]">
                    {row.summary}
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
