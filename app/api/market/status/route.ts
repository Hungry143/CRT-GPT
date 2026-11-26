import { NextResponse } from 'next/server';
import { buildMarketStatusPayload } from '@/server/routes/marketStatus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = await buildMarketStatusPayload();
  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
