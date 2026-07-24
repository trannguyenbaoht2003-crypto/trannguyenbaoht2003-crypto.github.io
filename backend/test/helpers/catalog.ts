import type { Pool } from 'pg';

import { registerPatchEvent } from '../../src/modules/patch/register-patch-event.js';
import { activateSourcePolicy } from '../../src/modules/source-policy/activate-source-policy.js';
import type { CatalogSnapshotV1 } from '../../src/modules/catalog/types.js';

export const CATALOG_IDS = {
  sourceId: '40000000-0000-4000-8000-000000000001',
  sourcePolicyRevisionId: '40000000-0000-4000-8000-000000000002',
  patchId: '40000000-0000-4000-8000-000000000003',
  patchEventId: '40000000-0000-4000-8000-000000000004',
  catalogRevisionId: '40000000-0000-4000-8000-000000000005',
} as const;

export function validCatalogSnapshot(): CatalogSnapshotV1 {
  return {
    schemaVersion: 1,
    patchKey: '26.15',
    gameModeExternalId: 'aram_mayhem',
    source: {
      adapterVersion: 'communitydragon-v1',
      sourceDigest: 'a'.repeat(64),
    },
    entities: [
      {
        entityType: 'mode',
        externalId: 'aram_mayhem',
        displayName: 'ARAM: Mayhem',
        active: true,
        attributes: {},
      },
      {
        entityType: 'champion',
        externalId: 'samira',
        displayName: 'Samira',
        active: true,
        attributes: {
          icon: 'https://example.invalid/samira.png',
        },
      },
      {
        entityType: 'augment',
        externalId: '1194',
        displayName: 'Ma Pháp Mê Hoặc',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '6672',
        displayName: 'Nỏ Tử Thủ',
        active: true,
        attributes: {},
      },
      {
        entityType: 'item',
        externalId: '3006',
        displayName: 'Giày Cuồng Nộ',
        active: true,
        attributes: {},
      },
    ],
    rules: [
      {
        ruleKey: 'aram-augment-limit',
        constraintType: 'limit',
        definition: {
          modeExternalId: 'aram_mayhem',
          entityType: 'augment',
          maxSelections: 3,
        },
      },
    ],
  };
}

export async function seedCatalogPrerequisites(pool: Pool): Promise<void> {
  await pool.query(`
    insert into sources (source_id, source_key, display_name)
    values (
      '40000000-0000-4000-8000-000000000001',
      'communitydragon',
      'CommunityDragon'
    )
  `);

  await activateSourcePolicy(pool, {
    actorId: 'catalog-test',
    collectorEnabled: true,
    correlationId: 'catalog-policy',
    reason: 'catalog test source',
    revision: 1,
    revisionId: CATALOG_IDS.sourcePolicyRevisionId,
    sourceId: CATALOG_IDS.sourceId,
    storagePermission: 'reference_only',
  });

  await registerPatchEvent(pool, {
    actorId: 'catalog-test',
    correlationId: 'catalog-patch',
    displayLabel: '26.15',
    eventId: CATALOG_IDS.patchEventId,
    lifecycleState: 'active',
    occurredAt: new Date('2026-07-24T00:00:00Z'),
    patchId: CATALOG_IDS.patchId,
    patchKey: '26.15',
    reason: 'catalog test patch',
  });
}
