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

function scenario(id, name, boundaries, commands, assertions, options = {}) {
  return Object.freeze({
    id,
    name,
    boundaries,
    initialState: Object.freeze(options.initialState ?? { fixture: 'base' }),
    commands: Object.freeze(commands),
    failurePoints: Object.freeze(options.failurePoints ?? []),
    expected: Object.freeze({
      assertions: Object.freeze(assertions),
      checksumMode: options.checksumMode ?? 'canonical_delta',
      auditRule: options.auditRule ?? 'all_required_mutations_audited',
      outboxRule: options.outboxRule ?? 'when_domain_event_required',
    }),
    passReasonCodes: Object.freeze(options.passReasonCodes ?? [`${id}_PASS`]),
    failReasonCodes: Object.freeze(options.failReasonCodes ?? [`${id}_INVARIANT_VIOLATION`, `${id}_EVIDENCE_MISSING`]),
  });
}

export const SCENARIOS = Object.freeze([
  scenario('S1', 'transaction_atomicity', ['T3'], ['register_candidate_with_failure_injection'], ['no_partial_candidate', 'no_orphan_claim', 'no_orphan_outbox'], { failurePoints: ['F01', 'F02'] }),
  scenario('S2', 'collector_idempotency', ['T2'], ['ingest_same_observation_100_times'], ['one_logical_observation', 'zero_duplicate_side_effects']),
  scenario('S3', 'idempotency_payload_conflict', ['T2'], ['reuse_key_with_different_payload'], ['conflict_rejected', 'previous_state_unchanged'], { failurePoints: ['F12'] }),
  scenario('S4', 'outbox_consistency_when_event_required', ['T1','T2','T3','T4','T5','T6','T7','T8','T9'], ['commit_domain_state', 'dispatch_outbox', 'replay_delivery'], ['required_event_has_pending_outbox', 'replay_is_idempotent'], { failurePoints: ['F03','F04','F05'], outboxRule: 'required_only_when_domain_event_required' }),
  scenario('S5', 'concurrent_review', ['T5'], ['complete_two_reviews_at_barrier'], ['no_lost_review', 'deterministic_quorum_result'], { failurePoints: ['F06'] }),
  scenario('S6', 'evidence_moderation_independence', ['T4','T6','T7'], ['record_supported_evidence', 'record_blocked_moderation', 'recompute_eligibility'], ['evidence_remains_supported', 'eligibility_ineligible']),
  scenario('S7', 'ai_publication_guard', ['T5','T7','T8'], ['evaluate_ai_candidate_without_confirmed_review', 'attempt_publish'], ['eligibility_needs_review', 'no_publication_version']),
  scenario('S8', 'publisher_authority', ['T8'], ['attempt_publish_without_publisher_permission'], ['command_rejected', 'eligibility_unchanged', 'no_publication_version']),
  scenario('S9', 'stale_authority_input', ['T7','T8'], ['evaluate_eligible', 'supersede_evidence_or_moderation', 'attempt_publish'], ['stale_input_detected', 'no_publication_version'], { failurePoints: ['F07'] }),
  scenario('S10', 'publication_rollback', ['T9'], ['publish_v1', 'publish_v2', 'rollback_to_v1', 'retry_rollback'], ['versions_immutable', 'active_pointer_v1', 'single_rollback_event']),
  scenario('S11', 'source_storage_permission', ['T1','T2'], ['ingest_reference_only_source_with_blob'], ['blob_not_stored', 'permitted_reference_retained']),
  scenario('S12', 'patch_catalog_mismatch', ['T3','T7'], ['validate_candidate_with_wrong_catalog_revision'], ['catalog_validation_failed', 'eligibility_ineligible']),
  scenario('S13', 'backup_restore', [], ['backup_fixture', 'mutate_state', 'restore_clean_environment'], ['record_counts_match', 'relations_match', 'checksums_match', 'active_pointers_match'], { failurePoints: ['F09'], checksumMode: 'full_state_equal' }),
  scenario('S14', 'public_read_path_isolation', ['T8'], ['stop_pipeline_workers', 'read_active_publication'], ['published_content_available', 'unpublished_candidate_hidden'], { failurePoints: ['F10'] }),
  scenario('S15', 'no_implicit_moderation_clear', ['T6','T7'], ['create_candidate_without_moderation', 'evaluate_eligibility', 'attempt_publish'], ['no_current_moderation_decision', 'eligibility_needs_review', 'publish_rejected']),
  scenario('S16', 'first_moderation_evaluation', ['T6'], ['evaluate_clear_input', 'evaluate_flagged_input', 'evaluate_blocked_input'], ['first_decision_can_be_clear_flagged_or_blocked', 'no_default_decision']),
  scenario('S17', 'moderation_snapshot_pinning', ['T6'], ['record_moderation_decision', 'change_signals', 'remoderate'], ['old_decision_pins_old_snapshot', 'new_decision_pins_new_snapshot', 'old_decision_immutable']),
  scenario('S18', 'superseded_moderation_race', ['T6','T7','T8'], ['evaluate_clear', 'evaluate_eligible', 'supersede_with_blocked', 'attempt_publish'], ['supersede_detected', 'no_publication_version', 'eligibility_ineligible'], { failurePoints: ['F07'] }),
  scenario('S19', 'claim_level_aggregation', ['T4','T7'], ['record_two_supported_one_insufficient_required_claims', 'recompute_eligibility'], ['eligibility_needs_review', 'no_candidate_level_shortcut']),
  scenario('S20', 'cross_patch_evidence', ['T4','T7'], ['load_supported_p1_decision', 'create_p2_candidate_revision', 'evaluate_without_revalidation', 'revalidate_for_p2'], ['p1_decision_not_current_for_p2', 'p2_not_eligible_before_revalidation', 'new_p2_decision_created']),
  scenario('S21', 'fingerprint_origin_independence', ['T3'], ['register_collector_candidate', 'register_ai_candidate_same_signature'], ['one_canonical_candidate', 'one_fingerprint', 'two_provenance_records']),
  scenario('S22', 'candidate_monitoring_projection', ['T8'], ['publish', 'delay_event_consumer', 'read_publication', 'consume_publication_event', 'replay_event'], ['publication_owner_is_publication_aggregate', 'public_read_available_before_projection', 'single_monitoring_transition']),
  scenario('S23', 'multi_reviewer_quorum', ['T5','T7'], ['set_quorum_two', 'complete_first_confirmed_review', 'recompute', 'complete_second_confirmed_review', 'recompute'], ['one_review_needs_review', 'two_reviews_can_satisfy_quorum']),
  scenario('S24', 'item_level_rollback', ['T9'], ['publish_two_items', 'rollback_first_item'], ['first_pointer_changed', 'second_pointer_unchanged']),
]);

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
