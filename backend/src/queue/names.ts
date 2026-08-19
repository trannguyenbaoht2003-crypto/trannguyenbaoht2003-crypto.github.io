export const NORMALIZATION_QUEUE_NAME = 'hai-dau-normalization-v1';
export const ELIGIBILITY_QUEUE_NAME = 'hai-dau-eligibility-v1';
export const PUBLICATION_QUEUE_NAME = 'hai-dau-publication-v1';
export const MONITORING_QUEUE_NAME = 'hai-dau-monitoring-v1';
export const AI_DISCOVERY_AUTOMATION_QUEUE_NAME = 'hai-dau-ai-discovery-automation-v1';

export interface OutboxJobData {
  aggregateId: string;
  aggregateType: string;
  correlationId: string;
  eventType: string;
  outboxEventId: string;
  payload: Record<string, unknown>;
}

export interface AiDiscoveryAutomationJobData {
  schemaVersion: 1;
}
