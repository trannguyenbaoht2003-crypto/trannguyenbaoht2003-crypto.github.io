export const NORMALIZATION_QUEUE_NAME = 'hai-dau-normalization-v1';
export const ELIGIBILITY_QUEUE_NAME = 'hai-dau-eligibility-v1';
export const PUBLICATION_QUEUE_NAME = 'hai-dau-publication-v1';

export interface OutboxJobData {
  aggregateId: string;
  aggregateType: string;
  correlationId: string;
  eventType: string;
  outboxEventId: string;
  payload: Record<string, unknown>;
}
