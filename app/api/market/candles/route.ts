import { NextRequest, NextResponse } from 'next/server';
import {
  buildMarketCandlesPayload,
  parseMarketCandlesQuery,
} from '@/server/routes/marketCandles';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const parsed = parseMarketCandlesQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        code: parsed.code,
        error: parsed.error,
      },
      {
        status: parsed.httpStatus,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }

  const payload = await buildMarketCandlesPayload({
    instrument: parsed.instrument,
    granularity: parsed.granularity,
    limit: parsed.limit,
  });

  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
