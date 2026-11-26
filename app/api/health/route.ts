import { NextResponse } from 'next/server';
import { buildHealthPayload } from '@/server/routes/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = buildHealthPayload();
  return NextResponse.json(payload, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
