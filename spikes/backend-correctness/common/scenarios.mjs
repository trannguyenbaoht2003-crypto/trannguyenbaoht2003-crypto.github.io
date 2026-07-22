export const FAILURE_POINTS = Object.freeze({
  F01: 'before_boundary',
  F02: 'after_first_write_inside_boundary',
  F03: 'after_domain_commit_before_outbox_dispatch',
  F04: 'after_enqueue_before_outbox_delivered',
  F05: 'after_consumer_effect_before_ack',
  F06: 'concurrent_human_review_barrier',
  F07: 'moderation_supersede_between_eligibility_and_publication',
  F08: 'after_lifecycle_event_before_active_pointer_update',
  F09: 'after_backup_before_destructive_mutation',
  F10: 'workers_stopped_public_read_path',
  F11: 'consumer_retry_limit_reached',
  F12: 'same_idempotency_key_different_payload',
});

export const TRANSACTION_BOUNDARIES = Object.freeze({
  T1: 'source_policy_activation',
  T2: 'raw_observation_ingest',
  T3: 'candidate_registration',
  T4: 'claim_evidence_decision',
  T5: 'human_review_completion',
  T6: 'moderation_evaluation',
  T7: 'eligibility_evaluation',
  T8: 'publication',
  T9: 'rollback',
});

export const SCENARIOS = Object.freeze([
  ['S1', 'transaction_atomicity', ['T3']],
  ['S2', 'collector_idempotency', ['T2']],
  ['S3', 'idempotency_payload_conflict', ['T2']],
  ['S4', 'outbox_consistency_when_event_required', ['T1','T2','T3','T4','T5','T6','T7','T8','T9']],
  ['S5', 'concurrent_review', ['T5']],
  ['S6', 'evidence_moderation_independence', ['T4','T6','T7']],
  ['S7', 'ai_publication_guard', ['T5','T7','T8']],
  ['S8', 'publisher_authority', ['T8']],
  ['S9', 'stale_authority_input', ['T7','T8']],
  ['S10', 'publication_rollback', ['T9']],
  ['S11', 'source_storage_permission', ['T1','T2']],
  ['S12', 'patch_catalog_mismatch', ['T3','T7']],
  ['S13', 'backup_restore', []],
  ['S14', 'public_read_path_isolation', ['T8']],
  ['S15', 'no_implicit_moderation_clear', ['T6','T7']],
  ['S16', 'first_moderation_evaluation', ['T6']],
  ['S17', 'moderation_snapshot_pinning', ['T6']],
  ['S18', 'superseded_moderation_race', ['T6','T7','T8']],
  ['S19', 'claim_level_aggregation', ['T4','T7']],
  ['S20', 'cross_patch_evidence', ['T4','T7']],
  ['S21', 'fingerprint_origin_independence', ['T3']],
  ['S22', 'candidate_monitoring_projection', ['T8']],
  ['S23', 'multi_reviewer_quorum', ['T5','T7']],
  ['S24', 'item_level_rollback', ['T9']],
].map(([id, name, boundaries]) => ({ id, name, boundaries })));

export const T7_OUTBOX_RULE = Object.freeze({
  alwaysCreatesEligibilityEvaluation: true,
  emitsEligibilityChangedOnlyWhenCurrentEligibilityChanges: true,
  unchangedResultRequiresAuditHistoryButNotEligibilityChanged: true,
});

export const ADAPTER_METHODS = Object.freeze([
  'resetEnvironment', 'loadFixture', 'executeCommand', 'injectFailure', 'releaseBarrier',
  'dispatchOutbox', 'drainQueue', 'snapshotState', 'computeChecksums', 'backupState',
  'restoreState', 'readPublishedContent', 'collectEvidence',
]);

export function assertAdapterContract(adapter) {
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter?.[method] !== 'function') throw new TypeError(`Missing adapter method: ${method}`);
  }
  return true;
}
