import {
  HealthResponseSchema,
  type HealthResponse,
} from '@/shared/contracts/api';
import { toUtcIsoString } from '@/shared/utils/time';

export const APP_SERVICE_NAME = 'crt-intelligence' as const;
export const APP_VERSION = '0.1.0' as const;

export function buildHealthPayload(now: Date = new Date()): HealthResponse {
  return HealthResponseSchema.parse({
    service: APP_SERVICE_NAME,
    version: APP_VERSION,
    status: 'ok',
    serverTimeUtc: toUtcIsoString(now),
  });
}
