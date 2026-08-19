import assert from 'node:assert/strict';
import test from 'node:test';

import { reserveAiOperationsRunBudgetWithFloor } from '../src/modules/ai-operations/reserve-ai-operations-run-budget.js';

test('Sprint 8D exposes a floor-aware budget reservation authority', () => {
  assert.equal(typeof reserveAiOperationsRunBudgetWithFloor, 'function');
});
