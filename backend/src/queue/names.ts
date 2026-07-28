export const NORMALIZATION_QUEUE_NAME = 'hai-dau-normalization-v1';

export interface OutboxJobData {
  aggregateId: string;
  aggregateType: string;
  correlationId: string;
  eventType: string;
  outboxEventId: string;
  payload: Record<string, unknown>;
}
