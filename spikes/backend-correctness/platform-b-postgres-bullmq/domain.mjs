import { createHash } from 'node:crypto';

const TABLES = [
  'source_policies', 'raw_observations', 'candidates', 'candidate_provenance', 'claims',
  'evidence_decisions', 'human_reviews', 'moderation_decisions', 'candidate_current_moderation',
  'eligibility_evaluations', 'candidate_current_eligibility', 'publications', 'publication_versions',
  'active_publications', 'candidate_projection', 'audit_events', 'outbox_events', 'consumer_effects',
  'idempotency_records', 'failure_controls', 'dead_letters', 'fixture_blob',
];

const SCHEMA_SQL = `
DROP TABLE IF EXISTS source_policies, raw_observations, candidates, candidate_provenance, claims,
  evidence_decisions, human_reviews, moderation_decisions, candidate_current_moderation,
  eligibility_evaluations, candidate_current_eligibility, publications, publication_versions,
  active_publications, candidate_projection, audit_events, outbox_events, consumer_effects,
  idempotency_records, failure_controls, dead_letters, fixture_blob, atomic_failure_sentinel CASCADE;
CREATE TABLE source_policies (policy_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, revision INTEGER NOT NULL, storage_permission TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE raw_observations (observation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_policy_id TEXT NOT NULL, reference_json TEXT NOT NULL, blob_text TEXT, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE candidates (candidate_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, patch_id TEXT NOT NULL, catalog_revision_id TEXT NOT NULL, origin TEXT NOT NULL, catalog_valid INTEGER NOT NULL, provenance_count INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE candidate_provenance (provenance_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, origin TEXT NOT NULL, source_ref TEXT, created_at TEXT NOT NULL);
CREATE TABLE claims (claim_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, required INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE evidence_decisions (decision_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, patch_id TEXT NOT NULL, state TEXT NOT NULL, input_snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE human_reviews (review_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, reviewer_id TEXT NOT NULL, confirmed INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(candidate_id, reviewer_id));
CREATE TABLE moderation_decisions (decision_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, state TEXT NOT NULL, input_snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE candidate_current_moderation (candidate_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL);
CREATE TABLE eligibility_evaluations (evaluation_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, result TEXT NOT NULL, moderation_decision_id TEXT, review_count INTEGER NOT NULL, claim_state_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE candidate_current_eligibility (candidate_id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE publications (publication_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE publication_versions (version_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, version_no INTEGER NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(publication_id, version_no));
CREATE TABLE active_publications (publication_id TEXT PRIMARY KEY, version_id TEXT NOT NULL);
CREATE TABLE candidate_projection (candidate_id TEXT PRIMARY KEY, monitoring INTEGER NOT NULL DEFAULT 0, transition_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE audit_events (audit_id TEXT PRIMARY KEY, command_type TEXT NOT NULL, entity_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE outbox_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
CREATE TABLE consumer_effects (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, processed_at TEXT NOT NULL);
CREATE TABLE idempotency_records (idempotency_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE failure_controls (point TEXT PRIMARY KEY, active INTEGER NOT NULL);
CREATE TABLE dead_letters (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, attempts INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE fixture_blob (fixture_id TEXT PRIMARY KEY, fixture_json TEXT NOT NULL, counts_json TEXT NOT NULL, checksum TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE atomic_failure_sentinel (sentinel_id TEXT PRIMARY KEY);
`;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

const now = () => new Date().toISOString();

async function failureActive(client, point) {
  const { rows } = await client.query('SELECT active FROM failure_controls WHERE point = $1', [point]);
  return Number(rows[0]?.active ?? 0) === 1;
}

function auditQuery(auditId, commandType, entityId, payload, createdAt) {
  return ['INSERT INTO audit_events (audit_id, command_type, entity_id, payload_json, created_at) VALUES ($1, $2, $3, $4, $5)', [auditId, commandType, entityId ?? null, JSON.stringify(payload ?? null), createdAt]];
}

function outboxQuery(eventId, eventType, payload, createdAt) {
  return ["INSERT INTO outbox_events (event_id, event_type, payload_json, delivery_state, created_at) VALUES ($1, $2, $3, 'pending', $4)", [eventId, eventType, JSON.stringify(payload ?? null), createdAt]];
}

async function transaction(pool, statements, failurePoints = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (failurePoints.includes('F01') && await failureActive(client, 'F01')) throw new Error('INJECTED_FAILURE:F01');
    const failAfterFirst = (failurePoints.includes('F02') && await failureActive(client, 'F02')) || (failurePoints.includes('F08') && await failureActive(client, 'F08'));
    for (let index = 0; index < statements.length; index += 1) {
      const [sql, params] = statements[index];
      await client.query(sql, params);
      if (index === 0 && failAfterFirst) throw new Error(failurePoints.includes('F08') ? 'INJECTED_FAILURE:F08' : 'INJECTED_FAILURE:F02');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function idempotencyLookup(pool, key, payloadHash) {
  if (!key) return null;
  const { rows } = await pool.query('SELECT payload_hash, result_json FROM idempotency_records WHERE idempotency_key = $1', [key]);
  const row = rows[0];
  if (!row) return null;
  if (row.payload_hash !== payloadHash) {
    const error = new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
    error.status = 409;
    throw error;
  }
  return JSON.parse(row.result_json);
}

function idempotencyQuery(key, payloadHash, result, createdAt) {
  if (!key) return null;
  return ['INSERT INTO idempotency_records (idempotency_key, payload_hash, result_json, created_at) VALUES ($1, $2, $3, $4)', [key, payloadHash, JSON.stringify(result), createdAt]];
}

export function createPostgresDomain({ pool, enqueue }) {
  async function reset() {
    await pool.query(SCHEMA_SQL);
    return { ok: true };
  }

  async function activateSourcePolicy(command) {
    const createdAt = now();
    await transaction(pool, [
      ['UPDATE source_policies SET active = 0 WHERE source_id = $1', [command.sourceId]],
      ['INSERT INTO source_policies (policy_id, source_id, revision, storage_permission, active, created_at) VALUES ($1, $2, $3, $4, 1, $5)', [command.policyId, command.sourceId, command.revision, command.storagePermission, createdAt]],
      auditQuery(command.auditId, command.type, command.policyId, command, createdAt),
      outboxQuery(command.eventId, 'SourcePolicyActivated', { policyId: command.policyId }, createdAt),
    ], ['F01', 'F02']);
    return { ok: true, policyId: command.policyId };
  }

  async function ingestObservation(command) {
    const payloadHash = command.payloadHash ?? sha256(command.payload ?? command);
    const existing = await idempotencyLookup(pool, command.idempotencyKey, payloadHash);
    if (existing) return { ...existing, replayed: true };
    const policyResult = await pool.query('SELECT policy_id, storage_permission FROM source_policies WHERE source_id = $1 AND active = 1', [command.sourceId]);
    const policy = policyResult.rows[0];
    if (!policy) throw new Error('SOURCE_POLICY_NOT_ACTIVE');
    const createdAt = now();
    const storedBlob = policy.storage_permission === 'blob_allowed' ? (command.blobText ?? null) : null;
    const result = { ok: true, observationId: command.observationId, blobStored: storedBlob != null, replayed: false };
    await transaction(pool, [
      ['INSERT INTO raw_observations (observation_id, source_id, source_policy_id, reference_json, blob_text, payload_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [command.observationId, command.sourceId, policy.policy_id, JSON.stringify(command.reference ?? null), storedBlob, payloadHash, createdAt]],
      auditQuery(command.auditId, command.type, command.observationId, command, createdAt),
      outboxQuery(command.eventId, 'RawObservationIngested', { observationId: command.observationId }, createdAt),
      idempotencyQuery(command.idempotencyKey, payloadHash, result, createdAt),
    ].filter(Boolean), ['F01', 'F02']);
    return result;
  }

  async function registerCandidate(command) {
    const existingResult = await pool.query('SELECT candidate_id FROM candidates WHERE fingerprint = $1', [command.fingerprint]);
    const existing = existingResult.rows[0];
    const createdAt = now();
    if (existing) {
      await transaction(pool, [
        ['UPDATE candidates SET provenance_count = provenance_count + 1 WHERE candidate_id = $1', [existing.candidate_id]],
        ['INSERT INTO candidate_provenance (provenance_id, candidate_id, origin, source_ref, created_at) VALUES ($1, $2, $3, $4, $5)', [command.provenanceId, existing.candidate_id, command.origin, command.sourceRef ?? null, createdAt]],
        auditQuery(command.auditId, 'candidate_provenance_added', existing.candidate_id, command, createdAt),
      ]);
      return { ok: true, candidateId: existing.candidate_id, deduplicated: true };
    }
    const statements = [
      ['INSERT INTO candidates (candidate_id, fingerprint, patch_id, catalog_revision_id, origin, catalog_valid, provenance_count, created_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)', [command.candidateId, command.fingerprint, command.patchId, command.catalogRevisionId, command.origin, command.catalogValid === false ? 0 : 1, createdAt]],
      ['INSERT INTO candidate_provenance (provenance_id, candidate_id, origin, source_ref, created_at) VALUES ($1, $2, $3, $4, $5)', [command.provenanceId, command.candidateId, command.origin, command.sourceRef ?? null, createdAt]],
      ['INSERT INTO candidate_projection (candidate_id, monitoring, transition_count) VALUES ($1, 0, 0)', [command.candidateId]],
    ];
    for (const claim of command.claims ?? []) statements.push(['INSERT INTO claims (claim_id, candidate_id, required, created_at) VALUES ($1, $2, $3, $4)', [claim.claimId, command.candidateId, claim.required === false ? 0 : 1, createdAt]]);
    statements.push(auditQuery(command.auditId, command.type, command.candidateId, command, createdAt), outboxQuery(command.eventId, 'CandidateRegistered', { candidateId: command.candidateId }, createdAt));
    await transaction(pool, statements, ['F01', 'F02']);
    return { ok: true, candidateId: command.candidateId, deduplicated: false };
  }

  async function decideClaimEvidence(command) {
    const createdAt = now();
    await transaction(pool, [
      ['INSERT INTO evidence_decisions (decision_id, claim_id, patch_id, state, input_snapshot_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [command.decisionId, command.claimId, command.patchId, command.state, JSON.stringify(command.inputSnapshot ?? null), createdAt]],
      auditQuery(command.auditId, command.type, command.claimId, command, createdAt),
      outboxQuery(command.eventId, 'ClaimEvidenceDecided', { claimId: command.claimId, patchId: command.patchId, state: command.state }, createdAt),
    ], ['F01', 'F02']);
    return { ok: true, decisionId: command.decisionId };
  }

  async function completeHumanReview(command) {
    const createdAt = now();
    await transaction(pool, [
      ['INSERT INTO human_reviews (review_id, candidate_id, reviewer_id, confirmed, created_at) VALUES ($1, $2, $3, $4, $5)', [command.reviewId, command.candidateId, command.reviewerId, command.confirmed ? 1 : 0, createdAt]],
      auditQuery(command.auditId, command.type, command.candidateId, command, createdAt),
      outboxQuery(command.eventId, 'HumanReviewCompleted', { candidateId: command.candidateId, reviewerId: command.reviewerId, confirmed: Boolean(command.confirmed) }, createdAt),
    ], ['F01', 'F02']);
    return { ok: true, reviewId: command.reviewId };
  }

  async function evaluateModeration(command) {
    if (!['clear', 'flagged', 'blocked'].includes(command.state)) throw new Error('INVALID_MODERATION_STATE');
    const createdAt = now();
    await transaction(pool, [
      ['INSERT INTO moderation_decisions (decision_id, candidate_id, state, input_snapshot_json, created_at) VALUES ($1, $2, $3, $4, $5)', [command.decisionId, command.candidateId, command.state, JSON.stringify(command.inputSnapshot ?? null), createdAt]],
      ['INSERT INTO candidate_current_moderation (candidate_id, decision_id) VALUES ($1, $2) ON CONFLICT(candidate_id) DO UPDATE SET decision_id = EXCLUDED.decision_id', [command.candidateId, command.decisionId]],
      auditQuery(command.auditId, command.type, command.candidateId, command, createdAt),
      outboxQuery(command.eventId, 'ModerationEvaluated', { candidateId: command.candidateId, decisionId: command.decisionId, state: command.state }, createdAt),
    ], ['F01', 'F02']);
    return { ok: true, decisionId: command.decisionId };
  }

  async function currentClaimStates(candidateId, patchId) {
    const claims = await pool.query('SELECT claim_id, required FROM claims WHERE candidate_id = $1 ORDER BY claim_id', [candidateId]);
    const states = [];
    for (const claim of claims.rows) {
      const decision = await pool.query('SELECT state, decision_id FROM evidence_decisions WHERE claim_id = $1 AND patch_id = $2 ORDER BY created_at DESC, decision_id DESC LIMIT 1', [claim.claim_id, patchId]);
      states.push({ claimId: claim.claim_id, required: Number(claim.required) === 1, state: decision.rows[0]?.state ?? null, decisionId: decision.rows[0]?.decision_id ?? null });
    }
    return states;
  }

  async function deriveEligibility(candidateId, reviewQuorum = 1) {
    const candidateResult = await pool.query('SELECT * FROM candidates WHERE candidate_id = $1', [candidateId]);
    const candidate = candidateResult.rows[0];
    if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
    const moderationResult = await pool.query('SELECT md.decision_id, md.state FROM candidate_current_moderation cm JOIN moderation_decisions md ON md.decision_id = cm.decision_id WHERE cm.candidate_id = $1', [candidateId]);
    const moderation = moderationResult.rows[0];
    const claimStates = await currentClaimStates(candidateId, candidate.patch_id);
    const reviewResult = await pool.query('SELECT COUNT(*) AS total FROM human_reviews WHERE candidate_id = $1 AND confirmed = 1', [candidateId]);
    const reviewCount = Number(reviewResult.rows[0]?.total ?? 0);
    let result = 'eligible';
    if (Number(candidate.catalog_valid) !== 1) result = 'ineligible';
    else if (!moderation) result = 'needs_review';
    else if (moderation.state === 'blocked') result = 'ineligible';
    else if (moderation.state === 'flagged') result = 'needs_review';
    else {
      const required = claimStates.filter((claim) => claim.required);
      if (required.some((claim) => claim.state === 'contradicted')) result = 'ineligible';
      else if (required.some((claim) => claim.state !== 'supported')) result = 'needs_review';
      else if (candidate.origin === 'ai_generated' && reviewCount < reviewQuorum) result = 'needs_review';
    }
    return { result, moderationDecisionId: moderation?.decision_id ?? null, reviewCount, claimStates, candidate };
  }

  async function evaluateEligibility(command) {
    const derived = await deriveEligibility(command.candidateId, command.reviewQuorum ?? 1);
    const currentResult = await pool.query('SELECT evaluation_id, result FROM candidate_current_eligibility WHERE candidate_id = $1', [command.candidateId]);
    const current = currentResult.rows[0];
    const changed = !current || current.result !== derived.result;
    const createdAt = now();
    const statements = [
      ['INSERT INTO eligibility_evaluations (evaluation_id, candidate_id, result, moderation_decision_id, review_count, claim_state_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [command.evaluationId, command.candidateId, derived.result, derived.moderationDecisionId, derived.reviewCount, JSON.stringify(derived.claimStates), createdAt]],
      ['INSERT INTO candidate_current_eligibility (candidate_id, evaluation_id, result) VALUES ($1, $2, $3) ON CONFLICT(candidate_id) DO UPDATE SET evaluation_id = EXCLUDED.evaluation_id, result = EXCLUDED.result', [command.candidateId, command.evaluationId, derived.result]],
      auditQuery(command.auditId, command.type, command.candidateId, { ...command, result: derived.result, changed }, createdAt),
    ];
    if (changed) statements.push(outboxQuery(command.eventId, 'EligibilityChanged', { candidateId: command.candidateId, evaluationId: command.evaluationId, result: derived.result }, createdAt));
    await transaction(pool, statements, ['F01', 'F02']);
    return { ok: true, evaluationId: command.evaluationId, result: derived.result, changed, moderationDecisionId: derived.moderationDecisionId, reviewCount: derived.reviewCount, claimStates: derived.claimStates };
  }

  async function publish(command) {
    if (!(command.actorPermissions ?? []).includes('publisher')) {
      const error = new Error('PUBLISHER_PERMISSION_REQUIRED');
      error.status = 403;
      throw error;
    }
    const currentResult = await pool.query('SELECT evaluation_id, result FROM candidate_current_eligibility WHERE candidate_id = $1', [command.candidateId]);
    const current = currentResult.rows[0];
    if (!current || current.result !== 'eligible') throw new Error('CANDIDATE_NOT_ELIGIBLE');
    if (command.expectedEligibilityEvaluationId && current.evaluation_id !== command.expectedEligibilityEvaluationId) throw new Error('STALE_ELIGIBILITY_EVALUATION');
    const moderationResult = await pool.query('SELECT cm.decision_id, md.state FROM candidate_current_moderation cm JOIN moderation_decisions md ON md.decision_id = cm.decision_id WHERE cm.candidate_id = $1', [command.candidateId]);
    const moderation = moderationResult.rows[0];
    if (!moderation || moderation.state !== 'clear') throw new Error('MODERATION_NOT_CLEAR');
    if (command.expectedModerationDecisionId && moderation.decision_id !== command.expectedModerationDecisionId) throw new Error('STALE_MODERATION_DECISION');
    const createdAt = now();
    await transaction(pool, [
      ['INSERT INTO publications (publication_id, candidate_id, created_at) VALUES ($1, $2, $3) ON CONFLICT(candidate_id) DO NOTHING', [command.publicationId, command.candidateId, createdAt]],
      ['INSERT INTO publication_versions (version_id, publication_id, version_no, content_json, created_at) VALUES ($1, $2, $3, $4, $5)', [command.versionId, command.publicationId, command.versionNo, JSON.stringify(command.content ?? null), createdAt]],
      ['INSERT INTO active_publications (publication_id, version_id) VALUES ($1, $2) ON CONFLICT(publication_id) DO UPDATE SET version_id = EXCLUDED.version_id', [command.publicationId, command.versionId]],
      auditQuery(command.auditId, command.type, command.publicationId, command, createdAt),
      outboxQuery(command.eventId, 'PublicationPublished', { publicationId: command.publicationId, versionId: command.versionId, candidateId: command.candidateId }, createdAt),
    ], ['F01', 'F02', 'F08']);
    return { ok: true, publicationId: command.publicationId, versionId: command.versionId };
  }

  async function rollback(command) {
    if (!(command.actorPermissions ?? []).includes('publisher')) {
      const error = new Error('PUBLISHER_PERMISSION_REQUIRED');
      error.status = 403;
      throw error;
    }
    const versionResult = await pool.query('SELECT version_id FROM publication_versions WHERE publication_id = $1 AND version_id = $2', [command.publicationId, command.targetVersionId]);
    if (!versionResult.rows[0]) throw new Error('ROLLBACK_TARGET_NOT_FOUND');
    const payloadHash = command.payloadHash ?? sha256(command);
    const existing = await idempotencyLookup(pool, command.idempotencyKey, payloadHash);
    if (existing) return { ...existing, replayed: true };
    const result = { ok: true, publicationId: command.publicationId, activeVersionId: command.targetVersionId, replayed: false };
    const createdAt = now();
    await transaction(pool, [
      ['UPDATE active_publications SET version_id = $1 WHERE publication_id = $2', [command.targetVersionId, command.publicationId]],
      auditQuery(command.auditId, command.type, command.publicationId, command, createdAt),
      outboxQuery(command.eventId, 'PublicationRolledBack', { publicationId: command.publicationId, targetVersionId: command.targetVersionId }, createdAt),
      idempotencyQuery(command.idempotencyKey, payloadHash, result, createdAt),
    ].filter(Boolean), ['F01', 'F02', 'F08']);
    return result;
  }

  async function executeCommand(command) {
    switch (command.type) {
      case 'activate_source_policy': return activateSourcePolicy(command);
      case 'ingest_observation': return ingestObservation(command);
      case 'register_candidate': return registerCandidate(command);
      case 'decide_claim_evidence': return decideClaimEvidence(command);
      case 'complete_human_review': return completeHumanReview(command);
      case 'evaluate_moderation': return evaluateModeration(command);
      case 'evaluate_eligibility': return evaluateEligibility(command);
      case 'publish': return publish(command);
      case 'rollback': return rollback(command);
      case 'simulate_consumer_retry_limit': {
        const createdAt = now();
        await pool.query('INSERT INTO dead_letters (event_id, event_type, attempts, payload_json, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(event_id) DO UPDATE SET attempts = EXCLUDED.attempts', [command.eventId, command.eventType, command.attempts ?? 3, JSON.stringify(command.payload ?? null), createdAt]);
        return { ok: true, deadLettered: command.eventId, attempts: command.attempts ?? 3 };
      }
      case 'redeliver_event':
        await enqueue({ eventId: command.eventId, eventType: command.eventType, payload: command.payload ?? null });
        return { ok: true, redelivered: command.eventId };
      default: {
        const error = new Error(`UNKNOWN_COMMAND:${command.type ?? 'null'}`);
        error.status = 400;
        throw error;
      }
    }
  }

  async function injectFailure(point) {
    await pool.query('INSERT INTO failure_controls (point, active) VALUES ($1, 1) ON CONFLICT(point) DO UPDATE SET active = 1', [point]);
    return { ok: true, point };
  }

  async function releaseFailure(point = null) {
    if (point) await pool.query('DELETE FROM failure_controls WHERE point = $1', [point]);
    else await pool.query('DELETE FROM failure_controls');
    return { ok: true };
  }

  async function dispatchOutbox() {
    const { rows } = await pool.query("SELECT event_id, event_type, payload_json FROM outbox_events WHERE delivery_state = 'pending' ORDER BY event_id");
    let dispatched = 0;
    for (const row of rows) {
      await enqueue({ eventId: row.event_id, eventType: row.event_type, payload: JSON.parse(row.payload_json) });
      dispatched += 1;
      const client = await pool.connect();
      try {
        if (await failureActive(client, 'F04')) throw new Error('INJECTED_FAILURE:F04');
      } finally {
        client.release();
      }
      await pool.query("UPDATE outbox_events SET delivery_state = 'delivered' WHERE event_id = $1 AND delivery_state = 'pending'", [row.event_id]);
    }
    return { ok: true, dispatched };
  }

  async function processEvent(body) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query('INSERT INTO consumer_effects (event_id, event_type, payload_json, processed_at) VALUES ($1, $2, $3, $4) ON CONFLICT(event_id) DO NOTHING RETURNING event_id', [body.eventId, body.eventType, JSON.stringify(body.payload ?? null), now()]);
      if (inserted.rowCount === 1 && body.eventType === 'PublicationPublished' && body.payload?.candidateId) {
        await client.query('UPDATE candidate_projection SET monitoring = 1, transition_count = CASE WHEN monitoring = 0 THEN transition_count + 1 ELSE transition_count END WHERE candidate_id = $1', [body.payload.candidateId]);
      }
      await client.query('COMMIT');
      if (await failureActive(client, 'F05')) throw new Error('INJECTED_FAILURE:F05');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function snapshot() {
    const counts = {};
    for (const table of TABLES) {
      const result = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
      counts[table] = Number(result.rows[0]?.total ?? 0);
    }
    const delivered = await pool.query("SELECT COUNT(*) AS total FROM outbox_events WHERE delivery_state = 'delivered'");
    const active = await pool.query('SELECT publication_id, version_id FROM active_publications ORDER BY publication_id');
    const eligibility = await pool.query('SELECT candidate_id, evaluation_id, result FROM candidate_current_eligibility ORDER BY candidate_id');
    const moderation = await pool.query('SELECT cm.candidate_id, cm.decision_id, md.state FROM candidate_current_moderation cm JOIN moderation_decisions md ON md.decision_id = cm.decision_id ORDER BY cm.candidate_id');
    const projections = await pool.query('SELECT candidate_id, monitoring, transition_count FROM candidate_projection ORDER BY candidate_id');
    return { outboxEvents: counts.outbox_events, consumerEffects: counts.consumer_effects, deliveredOutboxEvents: Number(delivered.rows[0]?.total ?? 0), counts, activePublications: active.rows, currentEligibility: eligibility.rows, currentModeration: moderation.rows, candidateProjection: projections.rows };
  }

  async function exportState() {
    const tables = {};
    for (const table of TABLES) {
      const result = await pool.query(`SELECT * FROM ${table} ORDER BY ctid`);
      tables[table] = result.rows;
    }
    return { tables };
  }

  async function importState(snapshotValue) {
    await reset();
    for (const table of TABLES) {
      const rows = snapshotValue?.tables?.[table] ?? [];
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        await pool.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, columns.map((column) => row[column]));
      }
    }
    return { ok: true };
  }

  async function loadFixture(body) {
    const createdAt = now();
    await pool.query("INSERT INTO fixture_blob (fixture_id, fixture_json, counts_json, checksum, created_at) VALUES ('common', $1, $2, $3, $4) ON CONFLICT(fixture_id) DO UPDATE SET fixture_json = EXCLUDED.fixture_json, counts_json = EXCLUDED.counts_json, checksum = EXCLUDED.checksum, created_at = EXCLUDED.created_at", [JSON.stringify(body.fixture), JSON.stringify(body.counts), body.checksum, createdAt]);
    return { ok: true, counts: body.counts, checksum: body.checksum };
  }

  async function publishedContent() {
    const result = await pool.query('SELECT p.publication_id, p.candidate_id, pv.version_id, pv.version_no, pv.content_json FROM publications p JOIN active_publications ap ON ap.publication_id = p.publication_id JOIN publication_versions pv ON pv.version_id = ap.version_id ORDER BY p.publication_id');
    return result.rows.map((row) => ({ publicationId: row.publication_id, candidateId: row.candidate_id, versionId: row.version_id, versionNo: Number(row.version_no), content: JSON.parse(row.content_json) }));
  }

  async function collectEvidence() {
    const audit = await pool.query('SELECT * FROM audit_events ORDER BY created_at, audit_id');
    const outbox = await pool.query('SELECT * FROM outbox_events ORDER BY created_at, event_id');
    const deadLetters = await pool.query('SELECT * FROM dead_letters ORDER BY event_id');
    const fixture = await pool.query("SELECT counts_json, checksum FROM fixture_blob WHERE fixture_id = 'common'");
    return { snapshot: await snapshot(), auditEvents: audit.rows, outboxLedger: outbox.rows, deadLetters: deadLetters.rows, fixture: fixture.rows[0] ? { counts: JSON.parse(fixture.rows[0].counts_json), checksum: fixture.rows[0].checksum } : null };
  }

  return Object.freeze({ reset, executeCommand, injectFailure, releaseFailure, dispatchOutbox, processEvent, snapshot, exportState, importState, loadFixture, publishedContent, collectEvidence });
}
