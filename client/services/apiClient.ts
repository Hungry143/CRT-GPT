import {
  HealthResponseSchema,
  InstrumentsResponseSchema,
  MarketCandlesResponseSchema,
  MarketSessionResponseSchema,
  MarketStatusResponseSchema,
  SignalsResponseSchema,
  SystemStatusResponseSchema,
  type HealthResponse,
  type InstrumentsResponse,
  type MarketCandlesResponse,
  type MarketSessionResponse,
  type MarketStatusResponse,
  type SignalsResponse,
  type SystemStatusResponse,
} from '@/shared/contracts/api';
import type { ZodType } from 'zod';

export interface EndpointCheckResult<T> {
  endpoint: string;
  ok: boolean;
  httpStatus: number | null;
  data: T | null;
  error: string | null;
  checkedAtUtc: string;
}

export interface DiagnosticsSnapshot {
  health: EndpointCheckResult<HealthResponse>;
  systemStatus: EndpointCheckResult<SystemStatusResponse>;
  instruments: EndpointCheckResult<InstrumentsResponse>;
  signals: EndpointCheckResult<SignalsResponse>;
  marketStatus: EndpointCheckResult<MarketStatusResponse>;
  marketCandles: EndpointCheckResult<MarketCandlesResponse>;
  marketSession: EndpointCheckResult<MarketSessionResponse>;
}

async function fetchValidatedJson<T>(
  endpoint: string,
  schema: ZodType<T>,
  signal?: AbortSignal
): Promise<EndpointCheckResult<T>> {
  const checkedAtUtc = new Date().toISOString();
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });

    if (!response.ok) {
      return {
        endpoint,
        ok: false,
        httpStatus: response.status,
        data: null,
        error: `HTTP ${response.status} ${response.statusText || 'Error'}`,
        checkedAtUtc,
      };
    }

    const rawJson: unknown = await response.json();
    const parsed = schema.safeParse(rawJson);

    if (!parsed.success) {
      return {
        endpoint,
        ok: false,
        httpStatus: response.status,
        data: null,
        error: `Response schema validation failed: ${parsed.error.issues[0]?.message ?? 'Invalid payload'}`,
        checkedAtUtc,
      };
    }

    return {
      endpoint,
      ok: true,
      httpStatus: response.status,
      data: parsed.data,
      error: null,
      checkedAtUtc,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Network request failed';
    return {
      endpoint,
      ok: false,
      httpStatus: null,
      data: null,
      error: message,
      checkedAtUtc,
    };
  }
}

export async function fetchHealth(
  signal?: AbortSignal
): Promise<EndpointCheckResult<HealthResponse>> {
  return fetchValidatedJson('/api/health', HealthResponseSchema, signal);
}

export async function fetchSystemStatus(
  signal?: AbortSignal
): Promise<EndpointCheckResult<SystemStatusResponse>> {
  return fetchValidatedJson(
    '/api/system/status',
    SystemStatusResponseSchema,
    signal
  );
}

export async function fetchInstruments(
  signal?: AbortSignal
): Promise<EndpointCheckResult<InstrumentsResponse>> {
  return fetchValidatedJson(
    '/api/instruments',
    InstrumentsResponseSchema,
    signal
  );
}

export async function fetchSignals(
  signal?: AbortSignal
): Promise<EndpointCheckResult<SignalsResponse>> {
  return fetchValidatedJson('/api/signals', SignalsResponseSchema, signal);
}

export async function fetchMarketStatus(
  signal?: AbortSignal
): Promise<EndpointCheckResult<MarketStatusResponse>> {
  return fetchValidatedJson(
    '/api/market/status',
    MarketStatusResponseSchema,
    signal
  );
}

export async function fetchMarketCandles(
  signal?: AbortSignal
): Promise<EndpointCheckResult<MarketCandlesResponse>> {
  return fetchValidatedJson(
    '/api/market/candles?instrument=XAUUSD&granularity=M15&limit=100',
    MarketCandlesResponseSchema,
    signal
  );
}

export async function fetchMarketSession(
  signal?: AbortSignal
): Promise<EndpointCheckResult<MarketSessionResponse>> {
  return fetchValidatedJson(
    '/api/market/session',
    MarketSessionResponseSchema,
    signal
  );
}

export async function fetchAllDiagnostics(
  signal?: AbortSignal
): Promise<DiagnosticsSnapshot> {
  const [
    health,
    systemStatus,
    instruments,
    signals,
    marketStatus,
    marketCandles,
    marketSession,
  ] = await Promise.all([
    fetchHealth(signal),
    fetchSystemStatus(signal),
    fetchInstruments(signal),
    fetchSignals(signal),
    fetchMarketStatus(signal),
    fetchMarketCandles(signal),
    fetchMarketSession(signal),
  ]);

  return {
    health,
    systemStatus,
    instruments,
    signals,
    marketStatus,
    marketCandles,
    marketSession,
  };
}
