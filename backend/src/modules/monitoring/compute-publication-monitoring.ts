import type {
  PublicationMonitoringComputation,
  PublicationMonitoringComputationInput,
} from './types.js';

export const MONITORING_NOT_APPLICABLE = Object.freeze({
  outcome: 'not_applicable',
  alertCode: null,
  severity: null,
} satisfies PublicationMonitoringComputation);

export const MONITORING_HEALTHY = Object.freeze({
  outcome: 'healthy',
  alertCode: null,
  severity: null,
} satisfies PublicationMonitoringComputation);

export const MONITORING_REVALIDATION_WARNING = Object.freeze({
  outcome: 'warning',
  alertCode: 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
  severity: 'warning',
} satisfies PublicationMonitoringComputation);

export const MONITORING_NEEDS_REVIEW_WARNING = Object.freeze({
  outcome: 'warning',
  alertCode: 'ACTIVE_PUBLICATION_NEEDS_REVIEW',
  severity: 'warning',
} satisfies PublicationMonitoringComputation);

export const MONITORING_INELIGIBLE_CRITICAL = Object.freeze({
  outcome: 'critical',
  alertCode: 'ACTIVE_PUBLICATION_INELIGIBLE',
  severity: 'critical',
} satisfies PublicationMonitoringComputation);

export function computePublicationMonitoring(
  input: PublicationMonitoringComputationInput,
): PublicationMonitoringComputation {
  if (!input.hasActivePublication) {
    return MONITORING_NOT_APPLICABLE;
  }
  if (
    input.sourceKind === 'eligibility'
    && !input.activeVersionMatchesEligibilitySource
  ) {
    return MONITORING_NOT_APPLICABLE;
  }
  if (!input.eligibilityCurrent || input.eligibilityOutcome === null) {
    return MONITORING_REVALIDATION_WARNING;
  }
  if (input.eligibilityOutcome === 'ineligible') {
    return MONITORING_INELIGIBLE_CRITICAL;
  }
  if (input.eligibilityOutcome === 'needs_review') {
    return MONITORING_NEEDS_REVIEW_WARNING;
  }
  return MONITORING_HEALTHY;
}
