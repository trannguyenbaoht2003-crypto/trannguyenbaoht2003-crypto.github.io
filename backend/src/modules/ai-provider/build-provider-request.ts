import type { NormalizedAiProviderExecutionInput } from './types.js';

export const AI_DISCOVERY_PROMPT_TEMPLATE_KEY = 'aram-mayhem-discovery' as const;
export const AI_DISCOVERY_PROMPT_TEMPLATE_VERSION = 1 as const;

const DEVELOPER_INSTRUCTION = [
  'You are a bounded ARAM Mayhem build discovery assistant.',
  'Select only IDs supplied in the input allow-lists.',
  'Provider output is advisory only and is not Evidence.',
  'Never invent identifiers, win rates, official status, trust decisions, or publication authority.',
  'Return zero or more proposals matching the required structured-output schema.',
].join(' ');

// Keep the provider-facing schema structural-only. Quantitative bounds and
// uniqueness are enforced again by local server validation so runtime model
// choice cannot weaken or make the provider schema incompatible.
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'subjectExternalId',
          'augmentExternalIds',
          'itemExternalIds',
          'rationale',
        ],
        properties: {
          subjectExternalId: {
            type: 'string',
          },
          augmentExternalIds: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          itemExternalIds: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          rationale: {
            type: ['string', 'null'],
          },
        },
      },
    },
  },
} as const;

export interface AiProviderRequest {
  promptTemplateKey: typeof AI_DISCOVERY_PROMPT_TEMPLATE_KEY;
  promptTemplateVersion: typeof AI_DISCOVERY_PROMPT_TEMPLATE_VERSION;
  input: NormalizedAiProviderExecutionInput;
  messages: readonly [
    { readonly role: 'developer'; readonly content: string },
    { readonly role: 'user'; readonly content: string },
  ];
  responseSchema: typeof RESPONSE_SCHEMA;
}

export function buildAiProviderRequest(
  input: NormalizedAiProviderExecutionInput,
): AiProviderRequest {
  const userPayload = {
    schemaVersion: 1,
    patchKey: input.patchKey,
    gameModeExternalId: input.gameModeExternalId,
    subjects: input.subjects,
  } as const;

  return {
    promptTemplateKey: AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
    promptTemplateVersion: AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
    input,
    messages: [
      { role: 'developer', content: DEVELOPER_INSTRUCTION },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
    responseSchema: RESPONSE_SCHEMA,
  };
}
