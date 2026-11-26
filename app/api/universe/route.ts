import { NextResponse } from 'next/server';
import { buildUniversePayload } from '@/server/routes/universe';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(buildUniversePayload(), {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
