import { NextResponse } from 'next/server';
import { buildInstrumentsPayload } from '@/server/routes/instruments';

export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = buildInstrumentsPayload();
  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
