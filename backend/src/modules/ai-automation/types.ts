import type { NormalizedAiProviderExecutionInput } from '../ai-provider/types.js';

export interface ScheduledAiDiscoverySubjectV1 {
  subjectExternalId: string;
  allowedAugmentExternalIds: string[];
  allowedItemExternalIds: string[];
  observations: string[];
}

export interface ScheduledAiDiscoveryContentV1 {
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  subjects: ScheduledAiDiscoverySubjectV1[];
}

export interface ScheduledAiDiscoveryIdentity {
  scheduledContentHash: string;
  runKey: string;
  idempotencyKey: string;
  aiDiscoveryRunId: string;
}

export interface BuiltScheduledAiDiscoveryInput extends ScheduledAiDiscoveryIdentity {
  content: ScheduledAiDiscoveryContentV1;
  input: NormalizedAiProviderExecutionInput;
}
