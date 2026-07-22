const SCHEMA_STATEMENTS = Object.freeze([
  'DROP TABLE IF EXISTS consumer_effects',
  'DROP TABLE IF EXISTS outbox_events',
  `CREATE TABLE outbox_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE consumer_effects (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    processed_at TEXT NOT NULL
  )`,
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('INVALID_JSON');
  }
}

async function resetDatabase(env) {
  await env.DB.batch(SCHEMA_STATEMENTS.map((statement) => env.DB.prepare(statement)));
}

async function snapshot(env) {
  const outbox = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN delivery_state = 'delivered' THEN 1 ELSE 0 END) AS delivered
    FROM outbox_events
  `).first();
  const effects = await env.DB.prepare('SELECT COUNT(*) AS total FROM consumer_effects').first();
  return {
    outboxEvents: Number(outbox?.total ?? 0),
    consumerEffects: Number(effects?.total ?? 0),
    deliveredOutboxEvents: Number(outbox?.delivered ?? 0),
  };
}

async function handleCommand(request, env) {
  const command = await readJson(request);
  const now = new Date().toISOString();

  if (command.type === 'record_outbox_event') {
    if (!command.eventId || !command.eventType) return json({ error: 'INVALID_COMMAND' }, 400);
    await env.DB.prepare(`
      INSERT INTO outbox_events (event_id, event_type, payload_json, delivery_state, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).bind(command.eventId, command.eventType, JSON.stringify(command.payload ?? null), now).run();
    return json({ ok: true, eventId: command.eventId });
  }

  if (command.type === 'redeliver_event') {
    if (!command.eventId || !command.eventType) return json({ error: 'INVALID_COMMAND' }, 400);
    await env.EVENT_QUEUE.send({
      eventId: command.eventId,
      eventType: command.eventType,
      payload: command.payload ?? null,
    });
    return json({ ok: true, redelivered: command.eventId });
  }

  return json({ error: 'UNKNOWN_COMMAND', type: command.type ?? null }, 400);
}

async function dispatchOutbox(env) {
  const rows = await env.DB.prepare(`
    SELECT event_id, event_type, payload_json
    FROM outbox_events
    WHERE delivery_state = 'pending'
    ORDER BY event_id
  `).all();

  for (const row of rows.results ?? []) {
    await env.EVENT_QUEUE.send({
      eventId: row.event_id,
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json),
    });
    await env.DB.prepare(`
      UPDATE outbox_events
      SET delivery_state = 'delivered'
      WHERE event_id = ? AND delivery_state = 'pending'
    `).bind(row.event_id).run();
  }

  return rows.results?.length ?? 0;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'POST' && pathname === '/__spike/reset') {
        await resetDatabase(env);
        return json({ ok: true });
      }

      if (request.method === 'POST' && pathname === '/__spike/command') {
        return await handleCommand(request, env);
      }

      if (request.method === 'POST' && pathname === '/__spike/dispatch-outbox') {
        const dispatched = await dispatchOutbox(env);
        return json({ ok: true, dispatched });
      }

      if (request.method === 'GET' && pathname === '/__spike/snapshot') {
        return json(await snapshot(env));
      }

      if (request.method === 'GET' && pathname === '/__spike/health') {
        return json({ ok: true, runtime: 'workerd', bindings: ['D1', 'Queues'] });
      }

      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body;
      await env.DB.prepare(`
        INSERT OR IGNORE INTO consumer_effects (event_id, event_type, payload_json, processed_at)
        VALUES (?, ?, ?, ?)
      `).bind(
        body.eventId,
        body.eventType,
        JSON.stringify(body.payload ?? null),
        new Date().toISOString(),
      ).run();
    }
  },
};
