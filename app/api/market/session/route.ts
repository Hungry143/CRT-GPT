import { NextResponse } from 'next/server';
import { buildMarketSessionPayload } from '@/server/routes/marketSession';

export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = await buildMarketSessionPayload();
  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
