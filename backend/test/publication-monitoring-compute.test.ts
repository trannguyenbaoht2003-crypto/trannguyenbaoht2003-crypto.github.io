import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computePublicationMonitoring,
} from '../src/modules/monitoring/compute-publication-monitoring.js';

const BASE = {
  activeVersionMatchesEligibilitySource: true,
  hasActivePublication: true,
} as const;

test('lifecycle monitoring fails closed when current eligibility is unavailable', () => {
  assert.deepEqual(computePublicationMonitoring({
    ...BASE,
    sourceKind: 'lifecycle',
    eligibilityCurrent: false,
    eligibilityOutcome: null,
  }), {
    outcome: 'warning',
    alertCode: 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
    severity: 'warning',
  });
});

test('current eligible authority is healthy', () => {
  assert.deepEqual(computePublicationMonitoring({
    ...BASE,
    sourceKind: 'lifecycle',
    eligibilityCurrent: true,
    eligibilityOutcome: 'eligible',
  }), {
    outcome: 'healthy',
    alertCode: null,
    severity: null,
  });
});

test('current needs-review authority opens a warning', () => {
  assert.deepEqual(computePublicationMonitoring({
    ...BASE,
    sourceKind: 'eligibility',
    eligibilityCurrent: true,
    eligibilityOutcome: 'needs_review',
  }), {
    outcome: 'warning',
    alertCode: 'ACTIVE_PUBLICATION_NEEDS_REVIEW',
    severity: 'warning',
  });
});

test('current ineligible authority opens a critical alert', () => {
  assert.deepEqual(computePublicationMonitoring({
    ...BASE,
    sourceKind: 'eligibility',
    eligibilityCurrent: true,
    eligibilityOutcome: 'ineligible',
  }), {
    outcome: 'critical',
    alertCode: 'ACTIVE_PUBLICATION_INELIGIBLE',
    severity: 'critical',
  });
});

test('eligibility event for a revision no longer active is not applicable', () => {
  assert.deepEqual(computePublicationMonitoring({
    ...BASE,
    sourceKind: 'eligibility',
    activeVersionMatchesEligibilitySource: false,
    eligibilityCurrent: true,
    eligibilityOutcome: 'ineligible',
  }), {
    outcome: 'not_applicable',
    alertCode: null,
    severity: null,
  });
});

test('eligibility event for active revision with stale authority requires revalidation', () => {
  assert.deepEqual(computePublicationMonitoring({
    ...BASE,
    sourceKind: 'eligibility',
    eligibilityCurrent: false,
    eligibilityOutcome: 'eligible',
  }), {
    outcome: 'warning',
    alertCode: 'ACTIVE_PUBLICATION_REVALIDATION_REQUIRED',
    severity: 'warning',
  });
});

test('no active Publication is not applicable regardless of eligibility outcome', () => {
  assert.deepEqual(computePublicationMonitoring({
    ...BASE,
    sourceKind: 'lifecycle',
    hasActivePublication: false,
    eligibilityCurrent: true,
    eligibilityOutcome: 'ineligible',
  }), {
    outcome: 'not_applicable',
    alertCode: null,
    severity: null,
  });
});
