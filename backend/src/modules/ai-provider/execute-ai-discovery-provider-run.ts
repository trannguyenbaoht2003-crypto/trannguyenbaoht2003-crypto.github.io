import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { recordAiDiscoveryRun } from '../ai-discovery/record-ai-discovery-run.js';
import type {
  RecordAiDiscoveryRunCommand,
  RecordAiDiscoveryRunResult,
} from '../ai-discovery/types.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import {
  AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
  AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
  buildAiProviderRequest,
} from './build-provider-request.js';
import {
  hashNormalizedAiProviderExecutionInput,
  normalizeAiProviderExecutionInput,
} from './normalize-provider-execution-input.js';
import {
  AiProviderError,
  type AiDiscoveryProvider,
  type AiProviderProposal,
} from './openai-responses-provider.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINTABLE_IDENTIFIER_PATTERN = /^[!-~]+$/u;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PROPOSALS = 64;
const MAX_SELECTION_IDS = 128;
const MAX_SELECTION_ID_LENGTH = 128;
const MAX_RATIONALE_LENGTH = 2_000;
const RETRY_DELAYS_MS = [500, 1_500] as const;

const SAFE_FAILURE_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AUTH_REJECTED',
  'PROVIDER_REQUEST_REJECTED',
  'PROVIDER_RESPONSE_INVALID',
  'PROVIDER_TRANSPORT_ERROR',
]);

const RETRYABLE_FAILURE_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TRANSPORT_ERROR',
]);

export interface ExecuteAiDiscoveryProviderRunCommand {
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  aiDiscoveryRunId: string;
  provider: AiDiscoveryProvider;
  modelKey: string;
  modelRevision: string;
  input: unknown;
  startedAt: string;
}

type RecordRun = (
  pool: Pool,
  command: RecordAiDiscoveryRunCommand,
) => Promise<RecordAiDiscoveryRunResult>;

export interface ExecuteAiDiscoveryProviderRunDependencies {
  recordRun?: RecordRun;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CanonicalProviderFailure {
  failureCode: string;
  retryable: boolean;
}

function failInput(): never {
  throw new Error('AI_PROVIDER_INPUT_INVALID');
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || value !== value.trim()
    || !PRINTABLE_IDENTIFIER_PATTERN.test(value)
  ) {
    return failInput();
  }
  return value;
}

function validateCommand(command: ExecuteAiDiscoveryProviderRunCommand): void {
  requireIdentifier(command.actorId);
  requireIdentifier(command.correlationId);
  requireIdentifier(command.idempotencyKey);
  requireIdentifier(command.modelKey);
  requireIdentifier(command.modelRevision);
  requireIdentifier(command.provider.providerKey);
  if (!UUID_PATTERN.test(command.aiDiscoveryRunId)) return failInput();
  if (Number.isNaN(Date.parse(command.startedAt))) return failInput();
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireProviderSelectionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION_IDS) {
    throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
  }
  const ids = value.map((entry) => {
    if (
      typeof entry !== 'string'
      || entry.length === 0
      || entry.length > MAX_SELECTION_ID_LENGTH
      || entry !== entry.trim()
      || !PRINTABLE_IDENTIFIER_PATTERN.test(entry)
    ) {
      throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length) {
    throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
  }
  return ids.sort(compareAscii);
}

function canonicalizeProviderProposals(
  value: unknown,
  normalizedInput: ReturnType<typeof normalizeAiProviderExecutionInput>,
): AiProviderProposal[] {
  if (!Array.isArray(value) || value.length > MAX_PROPOSALS) {
    throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
  }

  const subjects = new Map(
    normalizedInput.subjects.map((subject) => [subject.subjectExternalId, subject] as const),
  );
  const semanticKeys = new Set<string>();

  const proposals = value.map((entry): AiProviderProposal => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const required = [
      'augmentExternalIds',
      'itemExternalIds',
      'rationale',
      'subjectExternalId',
    ].sort();
    if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
      throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
    }

    if (
      typeof record.subjectExternalId !== 'string'
      || record.subjectExternalId.length === 0
      || record.subjectExternalId.length > MAX_SELECTION_ID_LENGTH
      || record.subjectExternalId !== record.subjectExternalId.trim()
      || !PRINTABLE_IDENTIFIER_PATTERN.test(record.subjectExternalId)
    ) {
      throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
    }
    if (
      record.rationale !== null
      && (typeof record.rationale !== 'string' || record.rationale.length > MAX_RATIONALE_LENGTH)
    ) {
      throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
    }

    const augmentExternalIds = requireProviderSelectionIds(record.augmentExternalIds);
    const itemExternalIds = requireProviderSelectionIds(record.itemExternalIds);
    const subject = subjects.get(record.subjectExternalId);
    if (!subject) {
      throw new AiProviderError('AI_PROVIDER_ALLOWLIST_VIOLATION', false, 'PROVIDER_RESPONSE_INVALID');
    }
    const augmentAllowlist = new Set(subject.allowedAugmentExternalIds);
    const itemAllowlist = new Set(subject.allowedItemExternalIds);
    if (
      augmentExternalIds.some((id) => !augmentAllowlist.has(id))
      || itemExternalIds.some((id) => !itemAllowlist.has(id))
    ) {
      throw new AiProviderError('AI_PROVIDER_ALLOWLIST_VIOLATION', false, 'PROVIDER_RESPONSE_INVALID');
    }

    const semanticKey = hashCanonicalJson({
      schemaVersion: 1,
      patchKey: normalizedInput.patchKey,
      gameModeExternalId: normalizedInput.gameModeExternalId,
      subjectExternalId: record.subjectExternalId,
      augmentExternalIds,
      itemExternalIds,
    });
    if (semanticKeys.has(semanticKey)) {
      throw new AiProviderError('AI_PROVIDER_OUTPUT_INVALID', false, 'PROVIDER_RESPONSE_INVALID');
    }
    semanticKeys.add(semanticKey);

    return {
      subjectExternalId: record.subjectExternalId,
      augmentExternalIds,
      itemExternalIds,
      rationale: record.rationale as string | null,
    };
  });

  return proposals.sort((left, right) => {
    const subject = compareAscii(left.subjectExternalId, right.subjectExternalId);
    if (subject !== 0) return subject;
    const augments = compareAscii(JSON.stringify(left.augmentExternalIds), JSON.stringify(right.augmentExternalIds));
    if (augments !== 0) return augments;
    const items = compareAscii(JSON.stringify(left.itemExternalIds), JSON.stringify(right.itemExternalIds));
    if (items !== 0) return items;
    return compareAscii(left.rationale ?? '', right.rationale ?? '');
  });
}

function deterministicProposalId(aiDiscoveryRunId: string, ordinal: number): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update('ai-provider-proposal-v1\0')
      .update(aiDiscoveryRunId)
      .update('\0')
      .update(String(ordinal))
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalFailure(error: unknown): CanonicalProviderFailure {
  if (error instanceof AiProviderError && SAFE_FAILURE_CODES.has(error.failureCode)) {
    return {
      failureCode: error.failureCode,
      retryable: error.retryable && RETRYABLE_FAILURE_CODES.has(error.failureCode),
    };
  }
  return {
    failureCode: 'PROVIDER_TRANSPORT_ERROR',
    retryable: false,
  };
}

function defaultNow(): string {
  return new Date().toISOString();
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function executeAiDiscoveryProviderRun(
  pool: Pool,
  command: ExecuteAiDiscoveryProviderRunCommand,
  dependencies: ExecuteAiDiscoveryProviderRunDependencies = {},
): Promise<RecordAiDiscoveryRunResult> {
  validateCommand(command);
  const normalizedInput = normalizeAiProviderExecutionInput(command.input);
  const inputHash = hashNormalizedAiProviderExecutionInput(normalizedInput);
  const request = buildAiProviderRequest(normalizedInput);
  const recordRun = dependencies.recordRun ?? recordAiDiscoveryRun;
  const now = dependencies.now ?? defaultNow;
  const sleep = dependencies.sleep ?? defaultSleep;

  let finalFailure: CanonicalProviderFailure | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const providerResult = await command.provider.execute(request);
      const proposals = canonicalizeProviderProposals(providerResult.proposals, normalizedInput);
      const canonicalOutput = {
        schemaVersion: 1,
        proposals: proposals.map((proposal) => ({
          subjectExternalId: proposal.subjectExternalId,
          augmentExternalIds: proposal.augmentExternalIds,
          itemExternalIds: proposal.itemExternalIds,
          rationale: proposal.rationale,
        })),
      } as const;
      const outputHash = hashCanonicalJson(canonicalOutput);

      return recordRun(pool, {
        actorId: command.actorId,
        aiDiscoveryRunId: command.aiDiscoveryRunId,
        correlationId: command.correlationId,
        idempotencyKey: command.idempotencyKey,
        runKey: normalizedInput.runKey,
        providerKey: command.provider.providerKey,
        modelKey: command.modelKey,
        modelRevision: command.modelRevision,
        promptTemplateKey: AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
        promptTemplateVersion: AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
        inputHash,
        outputHash,
        status: 'completed',
        startedAt: command.startedAt,
        completedAt: now(),
        failureCode: null,
        proposals: proposals.map((proposal, ordinal) => ({
          aiCandidateProposalId: deterministicProposalId(command.aiDiscoveryRunId, ordinal),
          ordinal,
          patchKey: normalizedInput.patchKey,
          gameModeExternalId: normalizedInput.gameModeExternalId,
          subjectExternalId: proposal.subjectExternalId,
          augmentExternalIds: proposal.augmentExternalIds,
          itemExternalIds: proposal.itemExternalIds,
          rationale: proposal.rationale,
        })),
      });
    } catch (error) {
      finalFailure = canonicalFailure(error);
      const retryDelay = RETRY_DELAYS_MS[attempt];
      if (finalFailure.retryable && retryDelay !== undefined) {
        await sleep(retryDelay);
        continue;
      }
      break;
    }
  }

  const failureCode = finalFailure?.failureCode ?? 'PROVIDER_TRANSPORT_ERROR';
  return recordRun(pool, {
    actorId: command.actorId,
    aiDiscoveryRunId: command.aiDiscoveryRunId,
    correlationId: command.correlationId,
    idempotencyKey: command.idempotencyKey,
    runKey: normalizedInput.runKey,
    providerKey: command.provider.providerKey,
    modelKey: command.modelKey,
    modelRevision: command.modelRevision,
    promptTemplateKey: AI_DISCOVERY_PROMPT_TEMPLATE_KEY,
    promptTemplateVersion: AI_DISCOVERY_PROMPT_TEMPLATE_VERSION,
    inputHash,
    outputHash: hashCanonicalJson({ schemaVersion: 1, failureCode }),
    status: 'failed',
    startedAt: command.startedAt,
    completedAt: now(),
    failureCode,
    proposals: [],
  });
}
