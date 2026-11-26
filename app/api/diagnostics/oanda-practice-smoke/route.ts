import { NextRequest, NextResponse } from 'next/server';
import { handleOandaPracticeDiagnosticRequest } from '@/server/routes/oandaPracticeDiagnostic';

export const dynamic = 'force-dynamic';

function buildMethodNotAllowedResponse() {
  return NextResponse.json(
    {
      error: 'Method not allowed; diagnostic requires POST.',
      reasonCode: 'METHOD_NOT_ALLOWED',
      checkedAtUtc: new Date().toISOString(),
    },
    {
      status: 405,
      headers: {
        Allow: 'POST',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}

export async function POST(req: NextRequest) {
  const result = await handleOandaPracticeDiagnosticRequest({
    method: req.method,
    url: req.url,
    headers: req.headers,
  });

  return NextResponse.json(result.body, {
    status: result.httpStatus,
    headers: result.headers,
  });
}

export async function GET() {
  return buildMethodNotAllowedResponse();
}

export async function PUT() {
  return buildMethodNotAllowedResponse();
}

export async function PATCH() {
  return buildMethodNotAllowedResponse();
}

export async function DELETE() {
  return buildMethodNotAllowedResponse();
}

export async function HEAD() {
  return buildMethodNotAllowedResponse();
}

export async function OPTIONS() {
  return buildMethodNotAllowedResponse();
}
