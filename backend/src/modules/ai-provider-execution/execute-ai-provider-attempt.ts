import type { AiProviderRequest } from '../ai-provider/build-provider-request.js';
import {
  AiProviderError,
  type AiDiscoveryProvider,
} from '../ai-provider/openai-responses-provider.js';
import type { AiProviderAttemptDisposition } from './types.js';

export interface ExecuteAiProviderAttemptCommand {
  provider: AiDiscoveryProvider;
  request: AiProviderRequest;
  clientRequestId: string;
}

export async function executeAiProviderAttempt(
  command: ExecuteAiProviderAttemptCommand,
): Promise<AiProviderAttemptDisposition> {
  try {
    const result = await command.provider.execute(command.request, {
      clientRequestId: command.clientRequestId,
    });
    return { kind: 'COMPLETED', result };
  } catch (error) {
    if (error instanceof AiProviderError) {
      const base = {
        failureCode: error.failureCode,
        providerRequestId: error.providerRequestId,
      };
      if (error.failureCode === 'PROVIDER_RATE_LIMITED') {
        return { kind: 'SAFE_RETRYABLE', ...base };
      }
      if (
        error.failureCode === 'PROVIDER_AUTH_REJECTED'
        || error.failureCode === 'PROVIDER_REQUEST_REJECTED'
        || error.failureCode === 'PROVIDER_RESPONSE_INVALID'
      ) {
        return { kind: 'SAFE_TERMINAL', ...base };
      }
      return { kind: 'UNCERTAIN', ...base };
    }
    return {
      kind: 'UNCERTAIN',
      failureCode: 'PROVIDER_TRANSPORT_ERROR',
      providerRequestId: null,
    };
  }
}
