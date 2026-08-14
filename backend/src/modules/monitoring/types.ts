export type PublicationMonitoringAlertCode =
  | 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED'
  | 'ACTIVE_PUBLICATION_NEEDS_REVIEW'
  | 'ACTIVE_PUBLICATION_INELIGIBLE';

export type PublicationMonitoringSeverity = 'warning' | 'critical';

export type PublicationMonitoringOutcome =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'not_applicable';

export type PublicationMonitoringSourceKind = 'eligibility' | 'lifecycle';

export type PublicationMonitoringEligibilityOutcome =
  | 'eligible'
  | 'needs_review'
  | 'ineligible';

export interface PublicationMonitoringComputationInput {
  sourceKind: PublicationMonitoringSourceKind;
  activeVersionMatchesEligibilitySource: boolean;
  hasActivePublication: boolean;
  eligibilityCurrent: boolean;
  eligibilityOutcome: PublicationMonitoringEligibilityOutcome | null;
}

export interface PublicationMonitoringComputation {
  outcome: PublicationMonitoringOutcome;
  alertCode: PublicationMonitoringAlertCode | null;
  severity: PublicationMonitoringSeverity | null;
}

export interface OpenPublicationMonitoringAlert {
  publicationId: string;
  publicationVersionId: string;
  candidateRevisionId: string;
  alertCode: PublicationMonitoringAlertCode;
  severity: PublicationMonitoringSeverity;
  eligibilityOutcome: PublicationMonitoringEligibilityOutcome | null;
  reasonCode: PublicationMonitoringAlertCode;
  evaluatedAt: string;
}
