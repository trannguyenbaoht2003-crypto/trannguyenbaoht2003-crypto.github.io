import { parseAiDiscoveryRunCliConfig } from './ai-discovery-run-cli.js';
import type { OpenAiResponsesProviderConfig } from './modules/ai-provider/openai-responses-provider.js';

export interface AiAutomationConfig {
  databaseUrl: string;
  redisUrl: string;
  schedulerEnabled: boolean;
  providerConfig?: OpenAiResponsesProviderConfig;
}

function required(env: NodeJS.ProcessEnv, name: 'DATABASE_URL' | 'REDIS_URL'): string {
  const value = env[name]?.trim();
  if (!value) throw new Error('AI_AUTOMATION_CONFIG_INVALID');
  return value;
}

function schedulerEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('AI_AUTOMATION_CONFIG_INVALID');
}

export function parseAiAutomationConfig(env: NodeJS.ProcessEnv): AiAutomationConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const redisUrl = required(env, 'REDIS_URL');
  const enabled = schedulerEnabled(env.AI_DISCOVERY_SCHEDULER_ENABLED);
  if (!enabled) {
    return { databaseUrl, redisUrl, schedulerEnabled: false };
  }

  let provider;
  try {
    provider = parseAiDiscoveryRunCliConfig(env);
  } catch {
    throw new Error('AI_AUTOMATION_CONFIG_INVALID');
  }
  const providerConfig: OpenAiResponsesProviderConfig = provider.endpoint === undefined
    ? {
        apiKey: provider.apiKey,
        model: provider.model,
        timeoutMs: provider.timeoutMs,
      }
    : {
        apiKey: provider.apiKey,
        model: provider.model,
        timeoutMs: provider.timeoutMs,
        endpoint: provider.endpoint,
      };
  return {
    databaseUrl,
    redisUrl,
    schedulerEnabled: true,
    providerConfig,
  };
}
