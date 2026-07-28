import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';
import { hashCanonicalJson } from '../../shared/hash.js';
import { normalizeCatalogSnapshot } from './normalize-catalog-snapshot.js';
import type { CatalogSnapshotV1 } from './types.js';

interface PatchAuthorityRow {
  lifecycle_state: string | null;
  patch_key: string;
}

interface SourcePolicyAuthorityRow {
  collector_enabled: boolean;
  source_policy_revision_id: string;
  status: string;
  storage_permission: string;
}

interface IdempotencyRow {
  payload_hash: string;
  result: ImportCatalogRevisionResult | null;
  state: string;
}

interface ConstraintError {
  code?: string;
  constraint?: string;
}

export interface ImportCatalogRevisionCommand {
  actorId: string;
  catalogRevisionId: string;
  correlationId: string;
  idempotencyKey: string;
  patchId: string;
  revision: number;
  sourceId: string;
  sourcePolicyRevisionId: string;
  snapshot: CatalogSnapshotV1;
}

export interface ImportCatalogRevisionResult {
  catalogRevisionId: string;
  contentHash: string;
  replayed: boolean;
}

function isConstraintError(
  error: unknown,
  constraint: string,
): error is ConstraintError {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const value = error as ConstraintError;
  return value.code === '23505' && value.constraint === constraint;
}

async function lockPatchAuthority(
  client: PoolClient,
  command: ImportCatalogRevisionCommand,
): Promise<void> {
  const result = await client.query<PatchAuthorityRow>(
    `select p.patch_key,
            (
              select ple.lifecycle_state
                from patch_lifecycle_events ple
               where ple.patch_id = p.patch_id
               order by ple.occurred_at desc,
                        ple.created_at desc,
                        ple.patch_lifecycle_event_id desc
               limit 1
            ) as lifecycle_state
       from patches p
      where p.patch_id = $1
      for update of p`,
    [command.patchId],
  );
  const patch = result.rows[0];
  if (!patch) {
    throw new Error('CATALOG_PATCH_NOT_FOUND');
  }
  if (patch.patch_key !== command.snapshot.patchKey) {
    throw new Error('CATALOG_PATCH_KEY_MISMATCH');
  }
  if (patch.lifecycle_state !== 'active') {
    throw new Error('CATALOG_PATCH_NOT_ACTIVE');
  }
}

async function lockSourcePolicyAuthority(
  client: PoolClient,
  command: ImportCatalogRevisionCommand,
): Promise<void> {
  const result = await client.query<SourcePolicyAuthorityRow>(
    `select asp.source_policy_revision_id,
            spr.collector_enabled,
            spr.storage_permission,
            s.status
       from active_source_policies asp
       join source_policy_revisions spr
         on spr.source_policy_revision_id = asp.source_policy_revision_id
       join sources s
         on s.source_id = asp.source_id
      where asp.source_id = $1
      for update of asp`,
    [command.sourceId],
  );
  const policy = result.rows[0];
  if (
    !policy
    || policy.source_policy_revision_id !== command.sourcePolicyRevisionId
    || policy.status !== 'active'
    || !policy.collector_enabled
    || policy.storage_permission === 'prohibited'
  ) {
    throw new Error('CATALOG_SOURCE_POLICY_NOT_ACTIVE');
  }
}

async function beginIdempotentImport(
  client: PoolClient,
  command: ImportCatalogRevisionCommand,
  payloadHash: string,
): Promise<ImportCatalogRevisionResult | null> {
  const inserted = await client.query(
    `insert into idempotency_records
      (scope, idempotency_key, payload_hash, state)
     values ('catalog_import', $1, $2, 'in_progress')
     on conflict (scope, idempotency_key) do nothing
     returning idempotency_record_id`,
    [command.idempotencyKey, payloadHash],
  );
  if (inserted.rowCount !== 0) {
    return null;
  }

  const existing = await client.query<IdempotencyRow>(
    `select payload_hash, state, result
       from idempotency_records
      where scope = 'catalog_import'
        and idempotency_key = $1
      for update`,
    [command.idempotencyKey],
  );
  const record = existing.rows[0];
  if (!record || record.payload_hash !== payloadHash) {
    throw new Error('IDEMPOTENCY_PAYLOAD_CONFLICT');
  }
  if (record.state !== 'completed' || record.result === null) {
    throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
  }
  return {
    ...record.result,
    replayed: true,
  };
}

async function resolveCanonicalEntityId(
  client: PoolClient,
  entityType: string,
  externalId: string,
): Promise<string> {
  const inserted = await client.query<{ game_entity_id: string }>(
    `insert into game_entities
      (game_entity_id, entity_type, canonical_external_id)
     values ($1, $2, $3)
     on conflict (entity_type, canonical_external_id) do nothing
     returning game_entity_id`,
    [randomUUID(), entityType, externalId],
  );
  const insertedId = inserted.rows[0]?.game_entity_id;
  if (insertedId) {
    return insertedId;
  }

  const existing = await client.query<{ game_entity_id: string }>(
    `select game_entity_id
       from game_entities
      where entity_type = $1
        and canonical_external_id = $2`,
    [entityType, externalId],
  );
  const existingId = existing.rows[0]?.game_entity_id;
  if (!existingId) {
    throw new Error('CATALOG_ENTITY_IDENTITY_RESOLUTION_FAILED');
  }
  return existingId;
}

export async function importCatalogRevision(
  pool: Pool,
  command: ImportCatalogRevisionCommand,
): Promise<ImportCatalogRevisionResult> {
  const normalized = normalizeCatalogSnapshot(command.snapshot);
  const payloadHash = hashCanonicalJson({
    actorId: command.actorId,
    catalogRevisionId: command.catalogRevisionId,
    patchId: command.patchId,
    revision: command.revision,
    snapshot: normalized.snapshot,
    sourceId: command.sourceId,
    sourcePolicyRevisionId: command.sourcePolicyRevisionId,
  });

  try {
    return await withTransaction(pool, async (client) => {
      await lockPatchAuthority(client, {
        ...command,
        snapshot: normalized.snapshot,
      });
      await lockSourcePolicyAuthority(client, command);

      const replay = await beginIdempotentImport(
        client,
        command,
        payloadHash,
      );
      if (replay) {
        return replay;
      }

      await client.query(
        `insert into catalog_revisions
          (catalog_revision_id, patch_id, revision, status,
           source_policy_revision_id)
         values ($1, $2, $3, 'draft', $4)`,
        [
          command.catalogRevisionId,
          command.patchId,
          command.revision,
          command.sourcePolicyRevisionId,
        ],
      );

      for (const entity of normalized.snapshot.entities) {
        const gameEntityId = await resolveCanonicalEntityId(
          client,
          entity.entityType,
          entity.externalId,
        );
        await client.query(
          `insert into game_entity_revisions
            (game_entity_revision_id, game_entity_id, catalog_revision_id,
             display_name, attributes, active)
           values ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            randomUUID(),
            gameEntityId,
            command.catalogRevisionId,
            entity.displayName,
            JSON.stringify(entity.attributes),
            entity.active,
          ],
        );
      }

      for (const rule of normalized.snapshot.rules) {
        await client.query(
          `insert into compatibility_rules
            (compatibility_rule_id, catalog_revision_id, rule_key,
             constraint_type, definition)
           values ($1, $2, $3, $4, $5::jsonb)`,
          [
            randomUUID(),
            command.catalogRevisionId,
            rule.ruleKey,
            rule.constraintType,
            JSON.stringify(rule.definition),
          ],
        );
      }

      await client.query(
        `insert into catalog_revision_seals
          (catalog_revision_id, schema_version, adapter_version,
           source_digest, game_mode_external_id, content_hash,
           entity_count, rule_count, sealed_by)
         values ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          command.catalogRevisionId,
          normalized.snapshot.source.adapterVersion,
          normalized.snapshot.source.sourceDigest,
          normalized.snapshot.gameModeExternalId,
          normalized.contentHash,
          normalized.snapshot.entities.length,
          normalized.snapshot.rules.length,
          command.actorId,
        ],
      );

      await client.query(
        `insert into catalog_lifecycle_events
          (catalog_lifecycle_event_id, catalog_revision_id,
           lifecycle_state, reason, actor_id, correlation_id)
         values ($1, $2, 'imported', 'deterministic catalog import',
                 $3, $4)`,
        [
          randomUUID(),
          command.catalogRevisionId,
          command.actorId,
          command.correlationId,
        ],
      );

      const eventPayload = {
        catalogRevisionId: command.catalogRevisionId,
        contentHash: normalized.contentHash,
        entityCount: normalized.snapshot.entities.length,
        gameModeExternalId: normalized.snapshot.gameModeExternalId,
        patchId: command.patchId,
        ruleCount: normalized.snapshot.rules.length,
      };
      await client.query(
        `insert into audit_events
          (audit_event_id, actor_id, action, reason, correlation_id,
           policy_version, payload)
         values ($1, $2, 'catalog.revision_imported',
                 'deterministic catalog import', $3, $4, $5::jsonb)`,
        [
          randomUUID(),
          command.actorId,
          command.correlationId,
          command.sourcePolicyRevisionId,
          JSON.stringify(eventPayload),
        ],
      );
      await client.query(
        `insert into outbox_events
          (outbox_event_id, aggregate_type, aggregate_id, event_type,
           payload, correlation_id)
         values ($1, 'catalog_revision', $2,
                 'CatalogRevisionImported', $3::jsonb, $4)`,
        [
          randomUUID(),
          command.catalogRevisionId,
          JSON.stringify(eventPayload),
          command.correlationId,
        ],
      );

      const result: ImportCatalogRevisionResult = {
        catalogRevisionId: command.catalogRevisionId,
        contentHash: normalized.contentHash,
        replayed: false,
      };
      await client.query(
        `update idempotency_records
            set state = 'completed',
                result = $2::jsonb,
                completed_at = clock_timestamp()
          where scope = 'catalog_import'
            and idempotency_key = $1`,
        [command.idempotencyKey, JSON.stringify(result)],
      );
      return result;
    });
  } catch (error) {
    if (
      isConstraintError(
        error,
        'catalog_revision_seals_content_hash_key',
      )
    ) {
      throw new Error('CATALOG_CONTENT_ALREADY_IMPORTED', {
        cause: error,
      });
    }
    throw error;
  }
}
