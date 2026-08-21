import type { AiProviderResult } from '../ai-provider/openai-responses-provider.js';

export type AiProviderExecutionStatus = 'PREPARED' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED' | 'UNCERTAIN';
export type AiProviderAttemptOrdinal = 1 | 2 | 3;
export type AiProviderReconciliationDecision = 'CONFIRMED_NOT_RECEIVED' | 'CONFIRMED_RECEIVED' | 'ABANDONED';

export type AiProviderAttemptDisposition =
  | { kind: 'COMPLETED'; result: AiProviderResult }
  | { kind: 'SAFE_RETRYABLE'; failureCode: string; providerRequestId: string | null }
  | { kind: 'SAFE_TERMINAL'; failureCode: string; providerRequestId: string | null }
  | { kind: 'UNCERTAIN'; failureCode: string; providerRequestId: string | null };
