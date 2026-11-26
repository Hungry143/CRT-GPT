import { NextResponse } from 'next/server';
import { buildSignalsPayload } from '@/server/routes/signals';

export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = buildSignalsPayload();
  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
