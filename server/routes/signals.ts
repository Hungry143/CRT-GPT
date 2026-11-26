import {
  SignalsResponseSchema,
  type SignalsResponse,
} from '@/shared/contracts/api';

/**
 * Returns the Stage 1 signals payload.
 * CRT engine is disabled in Stage 1, so data is strictly an empty array.
 */
export function buildSignalsPayload(): SignalsResponse {
  return SignalsResponseSchema.parse({
    data: [],
    state: 'ENGINE_DISABLED',
  });
}
