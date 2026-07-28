import type { PoolClient } from 'pg';

interface IdempotencyRow<T> {
  payload_hash: string;
  result: T | null;
  state: string;
}

export async function beginIdempotentCommand<T>(
  client: PoolClient,
  scope: string,
  idempotencyKey: string,
  payloadHash: string,
): Promise<T | null> {
  const inserted = await client.query(
    `insert into idempotency_records
      (scope, idempotency_key, payload_hash, state)
     values ($1, $2, $3, 'in_progress')
     on conflict (scope, idempotency_key) do nothing
     returning idempotency_record_id`,
    [scope, idempotencyKey, payloadHash],
  );
  if (inserted.rowCount !== 0) {
    return null;
  }

  const existing = await client.query<IdempotencyRow<T>>(
    `select payload_hash, state, result
       from idempotency_records
      where scope = $1
        and idempotency_key = $2
      for update`,
    [scope, idempotencyKey],
  );
  const record = existing.rows[0];
  if (!record || record.payload_hash !== payloadHash) {
    throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
  }
  if (record.state !== 'completed' || record.result === null) {
    throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
  }
  return record.result;
}

export async function completeIdempotentCommand<T>(
  client: PoolClient,
  scope: string,
  idempotencyKey: string,
  result: T,
): Promise<void> {
  const completed = await client.query(
    `update idempotency_records
        set state = 'completed',
            result = $3::jsonb,
            completed_at = clock_timestamp()
      where scope = $1
        and idempotency_key = $2
        and state = 'in_progress'`,
    [scope, idempotencyKey, JSON.stringify(result)],
  );
  if (completed.rowCount !== 1) {
    throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
  }
}
