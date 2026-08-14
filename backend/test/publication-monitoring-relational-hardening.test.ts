import assert from 'node:assert/strict';
import test from 'node:test';

import { resetDatabase } from './helpers/database.js';

test('delivery effect foreign key pins the exact outbox event to the exact monitoring alert event', async () => {
  const pool = await resetDatabase();
  try {
    const result = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(constraint_row.oid) as definition
         from pg_constraint constraint_row
         join pg_class table_row
           on table_row.oid = constraint_row.conrelid
        where table_row.relname = 'publication_monitoring_delivery_effects'
          and constraint_row.contype = 'f'`,
    );
    assert.ok(
      result.rows.some(({ definition }) => (
        /FOREIGN KEY \(outbox_event_id, publication_monitoring_alert_event_id, publication_id\)/.test(definition)
        && /REFERENCES publication_monitoring_alert_events\(outbox_event_id, publication_monitoring_alert_event_id, publication_id\)/.test(definition)
      )),
      'delivery effects must prove the persisted outbox belongs to the exact alert event',
    );
  } finally {
    await pool.end();
  }
});
