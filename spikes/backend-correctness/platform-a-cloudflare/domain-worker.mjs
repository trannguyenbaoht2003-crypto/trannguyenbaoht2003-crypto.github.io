const TABLES = [
  'source_policies', 'raw_observations', 'candidates', 'candidate_provenance', 'claims',
  'evidence_decisions', 'human_reviews', 'moderation_decisions', 'candidate_current_moderation',
  'eligibility_evaluations', 'candidate_current_eligibility', 'publications', 'publication_versions',
  'active_publications', 'candidate_projection', 'audit_events', 'outbox_events', 'consumer_effects',
  'idempotency_records', 'failure_controls', 'dead_letters', 'fixture_blob',
];

const SCHEMA_SQL = `
DROP TABLE IF EXISTS source_policies;
DROP TABLE IF EXISTS raw_observations;
DROP TABLE IF EXISTS candidates;
DROP TABLE IF EXISTS candidate_provenance;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS evidence_decisions;
DROP TABLE IF EXISTS human_reviews;
DROP TABLE IF EXISTS moderation_decisions;
DROP TABLE IF EXISTS candidate_current_moderation;
DROP TABLE IF EXISTS eligibility_evaluations;
DROP TABLE IF EXISTS candidate_current_eligibility;
DROP TABLE IF EXISTS publications;
DROP TABLE IF EXISTS publication_versions;
DROP TABLE IF EXISTS active_publications;
DROP TABLE IF EXISTS candidate_projection;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS consumer_effects;
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS failure_controls;
DROP TABLE IF EXISTS dead_letters;
DROP TABLE IF EXISTS fixture_blob;
DROP TABLE IF EXISTS atomic_failure_sentinel;
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
async function readJson(request) {
  try { return await request.json(); } catch { throw new Error('INVALID_JSON'); }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
const now = () => new Date().toISOString();
async function failureActive(env, point) {
  const row = await env.DB.prepare('SELECT active FROM failure_controls WHERE point = ?').bind(point).first();
  return Number(row?.active ?? 0) === 1;
}
function auditStatement(env, auditId, commandType, entityId, payload, createdAt) {
  return env.DB.prepare('INSERT INTO audit_events (audit_id, command_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(auditId, commandType, entityId ?? null, JSON.stringify(payload ?? null), createdAt);
}
function outboxStatement(env, eventId, eventType, payload, createdAt) {
  return env.DB.prepare("INSERT INTO outbox_events (event_id, event_type, payload_json, delivery_state, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(eventId, eventType, JSON.stringify(payload ?? null), createdAt);
}
async function idempotencyLookup(env, key, payloadHash) {
  if (!key) return null;
  const row = await env.DB.prepare('SELECT payload_hash, result_json FROM idempotency_records WHERE idempotency_key = ?').bind(key).first();
  if (!row) return null;
  if (row.payload_hash !== payloadHash) { const error = new Error('IDEMPOTENCY_PAYLOAD_CONFLICT'); error.status = 409; throw error; }
  return JSON.parse(row.result_json);
}
function idempotencyStatement(env, key, payloadHash, result, createdAt) {
  if (!key) return null;
  return env.DB.prepare('INSERT INTO idempotency_records (idempotency_key, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?)').bind(key, payloadHash, JSON.stringify(result), createdAt);
}
async function atomicBatch(env, statements, failurePoints = []) {
  if (failurePoints.includes('F01') && await failureActive(env, 'F01')) throw new Error('INJECTED_FAILURE:F01');
  const failInside = (failurePoints.includes('F02') && await failureActive(env, 'F02')) || (failurePoints.includes('F08') && await failureActive(env, 'F08'));
  if (failInside) statements.push(env.DB.prepare("INSERT INTO atomic_failure_sentinel (sentinel_id) VALUES ('atomic')"), env.DB.prepare("INSERT INTO atomic_failure_sentinel (sentinel_id) VALUES ('atomic')"));
  return env.DB.batch(statements.filter(Boolean));
}

async function activateSourcePolicy(command, env) {
  const createdAt = now();
  await atomicBatch(env, [
    env.DB.prepare('UPDATE source_policies SET active = 0 WHERE source_id = ?').bind(command.sourceId),
    env.DB.prepare('INSERT INTO source_policies (policy_id, source_id, revision, storage_permission, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').bind(command.policyId, command.sourceId, command.revision, command.storagePermission, createdAt),
    auditStatement(env, command.auditId, command.type, command.policyId, command, createdAt),
    outboxStatement(env, command.eventId, 'SourcePolicyActivated', { policyId: command.policyId }, createdAt),
  ], ['F01', 'F02']);
  return { ok: true, policyId: command.policyId };
}
async function ingestObservation(command, env) {
  const payloadHash = command.payloadHash ?? await sha256(command.payload ?? command);
  const existing = await idempotencyLookup(env, command.idempotencyKey, payloadHash);
  if (existing) return { ...existing, replayed: true };
  const policy = await env.DB.prepare('SELECT policy_id, storage_permission FROM source_policies WHERE source_id = ? AND active = 1').bind(command.sourceId).first();
  if (!policy) throw new Error('SOURCE_POLICY_NOT_ACTIVE');
  const createdAt = now();
  const storedBlob = policy.storage_permission === 'blob_allowed' ? (command.blobText ?? null) : null;
  const result = { ok: true, observationId: command.observationId, blobStored: storedBlob != null, replayed: false };
  await atomicBatch(env, [
    env.DB.prepare('INSERT INTO raw_observations (observation_id, source_id, source_policy_id, reference_json, blob_text, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(command.observationId, command.sourceId, policy.policy_id, JSON.stringify(command.reference ?? null), storedBlob, payloadHash, createdAt),
    auditStatement(env, command.auditId, command.type, command.observationId, command, createdAt),
    outboxStatement(env, command.eventId, 'RawObservationIngested', { observationId: command.observationId }, createdAt),
    idempotencyStatement(env, command.idempotencyKey, payloadHash, result, createdAt),
  ], ['F01', 'F02']);
  return result;
}
async function registerCandidate(command, env) {
  const existing = await env.DB.prepare('SELECT candidate_id FROM candidates WHERE fingerprint = ?').bind(command.fingerprint).first();
  const createdAt = now();
  if (existing) {
    await env.DB.batch([
      env.DB.prepare('UPDATE candidates SET provenance_count = provenance_count + 1 WHERE candidate_id = ?').bind(existing.candidate_id),
      env.DB.prepare('INSERT INTO candidate_provenance (provenance_id, candidate_id, origin, source_ref, created_at) VALUES (?, ?, ?, ?, ?)').bind(command.provenanceId, existing.candidate_id, command.origin, command.sourceRef ?? null, createdAt),
      auditStatement(env, command.auditId, 'candidate_provenance_added', existing.candidate_id, command, createdAt),
    ]);
    return { ok: true, candidateId: existing.candidate_id, deduplicated: true };
  }
  const statements = [
    env.DB.prepare('INSERT INTO candidates (candidate_id, fingerprint, patch_id, catalog_revision_id, origin, catalog_valid, provenance_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').bind(command.candidateId, command.fingerprint, command.patchId, command.catalogRevisionId, command.origin, command.catalogValid === false ? 0 : 1, createdAt),
    env.DB.prepare('INSERT INTO candidate_provenance (provenance_id, candidate_id, origin, source_ref, created_at) VALUES (?, ?, ?, ?, ?)').bind(command.provenanceId, command.candidateId, command.origin, command.sourceRef ?? null, createdAt),
    env.DB.prepare('INSERT INTO candidate_projection (candidate_id, monitoring, transition_count) VALUES (?, 0, 0)').bind(command.candidateId),
  ];
  for (const claim of command.claims ?? []) statements.push(env.DB.prepare('INSERT INTO claims (claim_id, candidate_id, required, created_at) VALUES (?, ?, ?, ?)').bind(claim.claimId, command.candidateId, claim.required === false ? 0 : 1, createdAt));
  statements.push(auditStatement(env, command.auditId, command.type, command.candidateId, command, createdAt), outboxStatement(env, command.eventId, 'CandidateRegistered', { candidateId: command.candidateId }, createdAt));
  await atomicBatch(env, statements, ['F01', 'F02']);
  return { ok: true, candidateId: command.candidateId, deduplicated: false };
}
async function decideClaimEvidence(command, env) {
  const createdAt = now();
  await atomicBatch(env, [
    env.DB.prepare('INSERT INTO evidence_decisions (decision_id, claim_id, patch_id, state, input_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(command.decisionId, command.claimId, command.patchId, command.state, JSON.stringify(command.inputSnapshot ?? null), createdAt),
    auditStatement(env, command.auditId, command.type, command.claimId, command, createdAt),
    outboxStatement(env, command.eventId, 'ClaimEvidenceDecided', { claimId: command.claimId, patchId: command.patchId, state: command.state }, createdAt),
  ], ['F01', 'F02']);
  return { ok: true, decisionId: command.decisionId };
}
async function completeHumanReview(command, env) {
  const createdAt = now();
  await atomicBatch(env, [
    env.DB.prepare('INSERT INTO human_reviews (review_id, candidate_id, reviewer_id, confirmed, created_at) VALUES (?, ?, ?, ?, ?)').bind(command.reviewId, command.candidateId, command.reviewerId, command.confirmed ? 1 : 0, createdAt),
    auditStatement(env, command.auditId, command.type, command.candidateId, command, createdAt),
    outboxStatement(env, command.eventId, 'HumanReviewCompleted', { candidateId: command.candidateId, reviewerId: command.reviewerId, confirmed: Boolean(command.confirmed) }, createdAt),
  ], ['F01', 'F02']);
  return { ok: true, reviewId: command.reviewId };
}
async function evaluateModeration(command, env) {
  if (!['clear', 'flagged', 'blocked'].includes(command.state)) throw new Error('INVALID_MODERATION_STATE');
  const createdAt = now();
  await atomicBatch(env, [
    env.DB.prepare('INSERT INTO moderation_decisions (decision_id, candidate_id, state, input_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(command.decisionId, command.candidateId, command.state, JSON.stringify(command.inputSnapshot ?? null), createdAt),
    env.DB.prepare('INSERT INTO candidate_current_moderation (candidate_id, decision_id) VALUES (?, ?) ON CONFLICT(candidate_id) DO UPDATE SET decision_id = excluded.decision_id').bind(command.candidateId, command.decisionId),
    auditStatement(env, command.auditId, command.type, command.candidateId, command, createdAt),
    outboxStatement(env, command.eventId, 'ModerationEvaluated', { candidateId: command.candidateId, decisionId: command.decisionId, state: command.state }, createdAt),
  ], ['F01', 'F02']);
  return { ok: true, decisionId: command.decisionId };
}
async function currentClaimStates(env, candidateId, patchId) {
  const claims = await env.DB.prepare('SELECT claim_id, required FROM claims WHERE candidate_id = ? ORDER BY claim_id').bind(candidateId).all();
  const states = [];
  for (const claim of claims.results ?? []) {
    const decision = await env.DB.prepare('SELECT state, decision_id FROM evidence_decisions WHERE claim_id = ? AND patch_id = ? ORDER BY created_at DESC, decision_id DESC LIMIT 1').bind(claim.claim_id, patchId).first();
    states.push({ claimId: claim.claim_id, required: Number(claim.required) === 1, state: decision?.state ?? null, decisionId: decision?.decision_id ?? null });
  }
  return states;
}
async function deriveEligibility(env, candidateId, reviewQuorum = 1) {
  const candidate = await env.DB.prepare('SELECT * FROM candidates WHERE candidate_id = ?').bind(candidateId).first();
  if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
  const moderation = await env.DB.prepare('SELECT md.decision_id, md.state FROM candidate_current_moderation cm JOIN moderation_decisions md ON md.decision_id = cm.decision_id WHERE cm.candidate_id = ?').bind(candidateId).first();
  const claimStates = await currentClaimStates(env, candidateId, candidate.patch_id);
  const review = await env.DB.prepare('SELECT COUNT(*) AS total FROM human_reviews WHERE candidate_id = ? AND confirmed = 1').bind(candidateId).first();
  const reviewCount = Number(review?.total ?? 0);
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
async function evaluateEligibility(command, env) {
  const derived = await deriveEligibility(env, command.candidateId, command.reviewQuorum ?? 1);
  const current = await env.DB.prepare('SELECT evaluation_id, result FROM candidate_current_eligibility WHERE candidate_id = ?').bind(command.candidateId).first();
  const changed = !current || current.result !== derived.result;
  const createdAt = now();
  const statements = [
    env.DB.prepare('INSERT INTO eligibility_evaluations (evaluation_id, candidate_id, result, moderation_decision_id, review_count, claim_state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(command.evaluationId, command.candidateId, derived.result, derived.moderationDecisionId, derived.reviewCount, JSON.stringify(derived.claimStates), createdAt),
    env.DB.prepare('INSERT INTO candidate_current_eligibility (candidate_id, evaluation_id, result) VALUES (?, ?, ?) ON CONFLICT(candidate_id) DO UPDATE SET evaluation_id = excluded.evaluation_id, result = excluded.result').bind(command.candidateId, command.evaluationId, derived.result),
    auditStatement(env, command.auditId, command.type, command.candidateId, { ...command, result: derived.result, changed }, createdAt),
  ];
  if (changed) statements.push(outboxStatement(env, command.eventId, 'EligibilityChanged', { candidateId: command.candidateId, evaluationId: command.evaluationId, result: derived.result }, createdAt));
  await atomicBatch(env, statements, ['F01', 'F02']);
  return { ok: true, evaluationId: command.evaluationId, result: derived.result, changed, moderationDecisionId: derived.moderationDecisionId, reviewCount: derived.reviewCount, claimStates: derived.claimStates };
}
async function publish(command, env) {
  if (!(command.actorPermissions ?? []).includes('publisher')) { const error = new Error('PUBLISHER_PERMISSION_REQUIRED'); error.status = 403; throw error; }
  const current = await env.DB.prepare('SELECT evaluation_id, result FROM candidate_current_eligibility WHERE candidate_id = ?').bind(command.candidateId).first();
  if (!current || current.result !== 'eligible') throw new Error('CANDIDATE_NOT_ELIGIBLE');
  if (command.expectedEligibilityEvaluationId && current.evaluation_id !== command.expectedEligibilityEvaluationId) throw new Error('STALE_ELIGIBILITY_EVALUATION');
  const moderation = await env.DB.prepare('SELECT cm.decision_id, md.state FROM candidate_current_moderation cm JOIN moderation_decisions md ON md.decision_id = cm.decision_id WHERE cm.candidate_id = ?').bind(command.candidateId).first();
  if (!moderation || moderation.state !== 'clear') throw new Error('MODERATION_NOT_CLEAR');
  if (command.expectedModerationDecisionId && moderation.decision_id !== command.expectedModerationDecisionId) throw new Error('STALE_MODERATION_DECISION');
  const createdAt = now();
  await atomicBatch(env, [
    env.DB.prepare('INSERT INTO publications (publication_id, candidate_id, created_at) VALUES (?, ?, ?) ON CONFLICT(candidate_id) DO NOTHING').bind(command.publicationId, command.candidateId, createdAt),
    env.DB.prepare('INSERT INTO publication_versions (version_id, publication_id, version_no, content_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(command.versionId, command.publicationId, command.versionNo, JSON.stringify(command.content ?? null), createdAt),
    env.DB.prepare('INSERT INTO active_publications (publication_id, version_id) VALUES (?, ?) ON CONFLICT(publication_id) DO UPDATE SET version_id = excluded.version_id').bind(command.publicationId, command.versionId),
    auditStatement(env, command.auditId, command.type, command.publicationId, command, createdAt),
    outboxStatement(env, command.eventId, 'PublicationPublished', { publicationId: command.publicationId, versionId: command.versionId, candidateId: command.candidateId }, createdAt),
  ], ['F01', 'F02', 'F08']);
  return { ok: true, publicationId: command.publicationId, versionId: command.versionId };
}
async function rollback(command, env) {
  if (!(command.actorPermissions ?? []).includes('publisher')) { const error = new Error('PUBLISHER_PERMISSION_REQUIRED'); error.status = 403; throw error; }
  const version = await env.DB.prepare('SELECT version_id FROM publication_versions WHERE publication_id = ? AND version_id = ?').bind(command.publicationId, command.targetVersionId).first();
  if (!version) throw new Error('ROLLBACK_TARGET_NOT_FOUND');
  const payloadHash = command.payloadHash ?? await sha256(command);
  const existing = await idempotencyLookup(env, command.idempotencyKey, payloadHash);
  if (existing) return { ...existing, replayed: true };
  const result = { ok: true, publicationId: command.publicationId, activeVersionId: command.targetVersionId, replayed: false };
  const createdAt = now();
  await atomicBatch(env, [
    env.DB.prepare('UPDATE active_publications SET version_id = ? WHERE publication_id = ?').bind(command.targetVersionId, command.publicationId),
    auditStatement(env, command.auditId, command.type, command.publicationId, command, createdAt),
    outboxStatement(env, command.eventId, 'PublicationRolledBack', { publicationId: command.publicationId, targetVersionId: command.targetVersionId }, createdAt),
    idempotencyStatement(env, command.idempotencyKey, payloadHash, result, createdAt),
  ], ['F01', 'F02', 'F08']);
  return result;
}
async function simulateConsumerRetryLimit(command, env) {
  const createdAt = now();
  await env.DB.prepare('INSERT INTO dead_letters (event_id, event_type, attempts, payload_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET attempts = excluded.attempts').bind(command.eventId, command.eventType, command.attempts ?? 3, JSON.stringify(command.payload ?? null), createdAt).run();
  return { ok: true, deadLettered: command.eventId, attempts: command.attempts ?? 3 };
}
async function handleCommand(request, env) {
  const command = await readJson(request);
  switch (command.type) {
    case 'activate_source_policy': return activateSourcePolicy(command, env);
    case 'ingest_observation': return ingestObservation(command, env);
    case 'register_candidate': return registerCandidate(command, env);
    case 'decide_claim_evidence': return decideClaimEvidence(command, env);
    case 'complete_human_review': return completeHumanReview(command, env);
    case 'evaluate_moderation': return evaluateModeration(command, env);
    case 'evaluate_eligibility': return evaluateEligibility(command, env);
    case 'publish': return publish(command, env);
    case 'rollback': return rollback(command, env);
    case 'simulate_consumer_retry_limit': return simulateConsumerRetryLimit(command, env);
    case 'redeliver_event': await env.EVENT_QUEUE.send({ eventId: command.eventId, eventType: command.eventType, payload: command.payload ?? null }); return { ok: true, redelivered: command.eventId };
    default: { const error = new Error(`UNKNOWN_COMMAND:${command.type ?? 'null'}`); error.status = 400; throw error; }
  }
}
async function dispatchOutbox(env) {
  const rows = await env.DB.prepare("SELECT event_id, event_type, payload_json FROM outbox_events WHERE delivery_state = 'pending' ORDER BY event_id").all();
  let dispatched = 0;
  for (const row of rows.results ?? []) {
    await env.EVENT_QUEUE.send({ eventId: row.event_id, eventType: row.event_type, payload: JSON.parse(row.payload_json) });
    dispatched += 1;
    if (await failureActive(env, 'F04')) throw new Error('INJECTED_FAILURE:F04');
    await env.DB.prepare("UPDATE outbox_events SET delivery_state = 'delivered' WHERE event_id = ? AND delivery_state = 'pending'").bind(row.event_id).run();
  }
  return dispatched;
}
async function snapshot(env) {
  const counts = {};
  for (const table of TABLES) { const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first(); counts[table] = Number(row?.total ?? 0); }
  const delivered = await env.DB.prepare("SELECT COUNT(*) AS total FROM outbox_events WHERE delivery_state = 'delivered'").first();
  const active = await env.DB.prepare('SELECT publication_id, version_id FROM active_publications ORDER BY publication_id').all();
  const eligibility = await env.DB.prepare('SELECT candidate_id, evaluation_id, result FROM candidate_current_eligibility ORDER BY candidate_id').all();
  const moderation = await env.DB.prepare('SELECT cm.candidate_id, cm.decision_id, md.state FROM candidate_current_moderation cm JOIN moderation_decisions md ON md.decision_id = cm.decision_id ORDER BY cm.candidate_id').all();
  const projections = await env.DB.prepare('SELECT candidate_id, monitoring, transition_count FROM candidate_projection ORDER BY candidate_id').all();
  return { outboxEvents: counts.outbox_events, consumerEffects: counts.consumer_effects, deliveredOutboxEvents: Number(delivered?.total ?? 0), counts, activePublications: active.results ?? [], currentEligibility: eligibility.results ?? [], currentModeration: moderation.results ?? [], candidateProjection: projections.results ?? [] };
}
async function exportState(env) {
  const tables = {};
  for (const table of TABLES) { const rows = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); tables[table] = rows.results ?? []; }
  return { tables };
}
async function importState(snapshotValue, env) {
  await env.DB.exec(SCHEMA_SQL);
  for (const table of TABLES) {
    const rows = snapshotValue?.tables?.[table] ?? [];
    for (let index = 0; index < rows.length; index += 50) {
      const statements = rows.slice(index, index + 50).map((row) => { const columns = Object.keys(row); return env.DB.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).bind(...columns.map((column) => row[column])); });
      if (statements.length) await env.DB.batch(statements);
    }
  }
  return { ok: true };
}
async function loadFixture(request, env) {
  const body = await readJson(request); const createdAt = now();
  await env.DB.prepare("INSERT INTO fixture_blob (fixture_id, fixture_json, counts_json, checksum, created_at) VALUES ('common', ?, ?, ?, ?) ON CONFLICT(fixture_id) DO UPDATE SET fixture_json = excluded.fixture_json, counts_json = excluded.counts_json, checksum = excluded.checksum, created_at = excluded.created_at").bind(JSON.stringify(body.fixture), JSON.stringify(body.counts), body.checksum, createdAt).run();
  return { ok: true, counts: body.counts, checksum: body.checksum };
}
async function publishedContent(env) {
  const rows = await env.DB.prepare('SELECT p.publication_id, p.candidate_id, pv.version_id, pv.version_no, pv.content_json FROM publications p JOIN active_publications ap ON ap.publication_id = p.publication_id JOIN publication_versions pv ON pv.version_id = ap.version_id ORDER BY p.publication_id').all();
  return (rows.results ?? []).map((row) => ({ publicationId: row.publication_id, candidateId: row.candidate_id, versionId: row.version_id, versionNo: Number(row.version_no), content: JSON.parse(row.content_json) }));
}
async function collectEvidence(env) {
  const audit = await env.DB.prepare('SELECT * FROM audit_events ORDER BY created_at, audit_id').all();
  const outbox = await env.DB.prepare('SELECT * FROM outbox_events ORDER BY created_at, event_id').all();
  const deadLetters = await env.DB.prepare('SELECT * FROM dead_letters ORDER BY event_id').all();
  const fixture = await env.DB.prepare("SELECT counts_json, checksum FROM fixture_blob WHERE fixture_id = 'common'").first();
  return { snapshot: await snapshot(env), auditEvents: audit.results ?? [], outboxLedger: outbox.results ?? [], deadLetters: deadLetters.results ?? [], fixture: fixture ? { counts: JSON.parse(fixture.counts_json), checksum: fixture.checksum } : null };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'POST' && pathname === '/__spike/reset') { await env.DB.exec(SCHEMA_SQL); return json({ ok: true }); }
      if (request.method === 'POST' && pathname === '/__spike/command') return json(await handleCommand(request, env));
      if (request.method === 'POST' && pathname === '/__spike/inject-failure') { const body = await readJson(request); await env.DB.prepare('INSERT INTO failure_controls (point, active) VALUES (?, 1) ON CONFLICT(point) DO UPDATE SET active = 1').bind(body.point).run(); return json({ ok: true, point: body.point }); }
      if (request.method === 'POST' && pathname === '/__spike/release-failure') { const body = await readJson(request); if (body.point) await env.DB.prepare('DELETE FROM failure_controls WHERE point = ?').bind(body.point).run(); else await env.DB.prepare('DELETE FROM failure_controls').run(); return json({ ok: true }); }
      if (request.method === 'POST' && pathname === '/__spike/dispatch-outbox') return json({ ok: true, dispatched: await dispatchOutbox(env) });
      if (request.method === 'POST' && pathname === '/__spike/load-fixture') return json(await loadFixture(request, env));
      if (request.method === 'POST' && pathname === '/__spike/import') return json(await importState(await readJson(request), env));
      if (request.method === 'GET' && pathname === '/__spike/export') return json(await exportState(env));
      if (request.method === 'GET' && pathname === '/__spike/snapshot') return json(await snapshot(env));
      if (request.method === 'GET' && pathname === '/__spike/published') return json(await publishedContent(env));
      if (request.method === 'GET' && pathname === '/__spike/evidence') return json(await collectEvidence(env));
      if (request.method === 'GET' && pathname === '/__spike/health') return json({ ok: true, runtime: 'workerd', bindings: ['D1', 'Queues'] });
      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error?.status ?? 500); }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body; const createdAt = now();
      await env.DB.prepare('INSERT OR IGNORE INTO consumer_effects (event_id, event_type, payload_json, processed_at) VALUES (?, ?, ?, ?)').bind(body.eventId, body.eventType, JSON.stringify(body.payload ?? null), createdAt).run();
      if (body.eventType === 'PublicationPublished' && body.payload?.candidateId) {
        await env.DB.prepare('UPDATE candidate_projection SET monitoring = 1, transition_count = CASE WHEN monitoring = 0 THEN transition_count + 1 ELSE transition_count END WHERE candidate_id = ?').bind(body.payload.candidateId).run();
      }
      if (await failureActive(env, 'F05')) throw new Error('INJECTED_FAILURE:F05');
    }
  },
};