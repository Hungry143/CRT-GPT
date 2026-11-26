import { NextResponse } from 'next/server';
import { buildSystemStatusPayload } from '@/server/routes/systemStatus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = buildSystemStatusPayload();
  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
