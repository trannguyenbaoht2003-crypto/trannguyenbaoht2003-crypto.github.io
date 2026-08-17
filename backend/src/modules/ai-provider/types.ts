export interface AiProviderExecutionSubjectInput {
  subjectExternalId: string;
  allowedAugmentExternalIds: readonly string[];
  allowedItemExternalIds: readonly string[];
  observations: readonly string[];
}

export interface AiProviderExecutionInput {
  runKey: string;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  subjects: readonly AiProviderExecutionSubjectInput[];
}

export interface NormalizedAiProviderExecutionSubject {
  subjectExternalId: string;
  allowedAugmentExternalIds: string[];
  allowedItemExternalIds: string[];
  observations: string[];
}

export interface NormalizedAiProviderExecutionInput {
  runKey: string;
  patchKey: string;
  gameModeExternalId: 'aram_mayhem';
  subjects: NormalizedAiProviderExecutionSubject[];
}
