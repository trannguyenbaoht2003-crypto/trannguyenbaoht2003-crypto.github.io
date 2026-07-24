import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../../database/transaction.js';

interface PatchAuthorityRow {
  lifecycle_state: string | null;
}

interface CatalogActivationAuthorityRow {
  content_hash: string;
  game_mode_external_id: string;
  patch_id: string;
}

interface ValidationAuthorityRow {
  result: string;
  sealed_content_hash: string;
}

interface ActiveCatalogRow {
  catalog_revision_id: string;
}

export interface ActivateCatalogRevisionCommand {
  actorId: string;
  catalogRevisionId: string;
  correlationId: string;
  expectedCurrentCatalogRevisionId: string | null;
  patchId: string;
  reason: string;
}

export interface ActivateCatalogRevisionResult {
  activeCatalogRevisionId: string;
  previousCatalogRevisionId: string | null;
}

async function lockActivePatch(
  client: PoolClient,
  patchId: string,
): Promise<void> {
  const result = await client.query<PatchAuthorityRow>(
    `select (
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
    [patchId],
  );
  if (result.rows[0]?.lifecycle_state !== 'active') {
    throw new Error('CATALOG_PATCH_NOT_ACTIVE');
  }
}

async function loadActivationAuthority(
  client: PoolClient,
  catalogRevisionId: string,
): Promise<CatalogActivationAuthorityRow> {
  const result = await client.query<CatalogActivationAuthorityRow>(
    `select seal.content_hash,
            seal.game_mode_external_id,
            cr.patch_id
       from catalog_revisions cr
       join catalog_revision_seals seal
         on seal.catalog_revision_id = cr.catalog_revision_id
      where cr.catalog_revision_id = $1`,
    [catalogRevisionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('CATALOG_REVISION_NOT_SEALED');
  }
  return row;
}

async function requirePassedValidation(
  client: PoolClient,
  catalogRevisionId: string,
  contentHash: string,
): Promise<void> {
  const result = await client.query<ValidationAuthorityRow>(
    `select result, sealed_content_hash
       from catalog_validation_results
      where catalog_revision_id = $1
      order by validated_at desc,
               catalog_validation_result_id desc
      limit 1`,
    [catalogRevisionId],
  );
  const validation = result.rows[0];
  if (
    !validation
    || validation.result !== 'passed'
    || validation.sealed_content_hash !== contentHash
  ) {
    throw new Error('CATALOG_VALIDATION_REQUIRED');
  }
}

export async function activateCatalogRevision(
  pool: Pool,
  command: ActivateCatalogRevisionCommand,
): Promise<ActivateCatalogRevisionResult> {
  return withTransaction(pool, async (client) => {
    await lockActivePatch(client, command.patchId);
    const authority = await loadActivationAuthority(
      client,
      command.catalogRevisionId,
    );
    if (authority.patch_id !== command.patchId) {
      throw new Error('CATALOG_PATCH_MISMATCH');
    }
    await requirePassedValidation(
      client,
      command.catalogRevisionId,
      authority.content_hash,
    );

    const currentResult = await client.query<ActiveCatalogRow>(
      `select catalog_revision_id
         from active_catalog_revisions
        where patch_id = $1
          and game_mode_external_id = $2
        for update`,
      [command.patchId, authority.game_mode_external_id],
    );
    const currentCatalogRevisionId = (
      currentResult.rows[0]?.catalog_revision_id ?? null
    );
    if (
      currentCatalogRevisionId
      !== command.expectedCurrentCatalogRevisionId
    ) {
      throw new Error('CATALOG_ACTIVE_POINTER_CONFLICT');
    }
    if (currentCatalogRevisionId === command.catalogRevisionId) {
      return {
        activeCatalogRevisionId: command.catalogRevisionId,
        previousCatalogRevisionId: currentCatalogRevisionId,
      };
    }

    if (currentCatalogRevisionId === null) {
      await client.query(
        `insert into active_catalog_revisions
          (patch_id, game_mode_external_id, catalog_revision_id)
         values ($1, $2, $3)`,
        [
          command.patchId,
          authority.game_mode_external_id,
          command.catalogRevisionId,
        ],
      );
    } else {
      await client.query(
        `update active_catalog_revisions
            set catalog_revision_id = $3,
                activated_at = clock_timestamp()
          where patch_id = $1
            and game_mode_external_id = $2`,
        [
          command.patchId,
          authority.game_mode_external_id,
          command.catalogRevisionId,
        ],
      );
      await client.query(
        `insert into catalog_lifecycle_events
          (catalog_lifecycle_event_id, catalog_revision_id,
           lifecycle_state, reason, actor_id, correlation_id)
         values ($1, $2, 'superseded', $3, $4, $5)`,
        [
          randomUUID(),
          currentCatalogRevisionId,
          command.reason,
          command.actorId,
          command.correlationId,
        ],
      );
    }

    await client.query(
      `insert into catalog_lifecycle_events
        (catalog_lifecycle_event_id, catalog_revision_id,
         lifecycle_state, reason, actor_id, correlation_id)
       values ($1, $2, 'activated', $3, $4, $5)`,
      [
        randomUUID(),
        command.catalogRevisionId,
        command.reason,
        command.actorId,
        command.correlationId,
      ],
    );

    const eventPayload = {
      catalogRevisionId: command.catalogRevisionId,
      contentHash: authority.content_hash,
      gameModeExternalId: authority.game_mode_external_id,
      patchId: command.patchId,
      previousCatalogRevisionId: currentCatalogRevisionId,
    };
    await client.query(
      `insert into audit_events
        (audit_event_id, actor_id, action, reason, correlation_id, payload)
       values ($1, $2, 'catalog.revision_activated', $3, $4, $5::jsonb)`,
      [
        randomUUID(),
        command.actorId,
        command.reason,
        command.correlationId,
        JSON.stringify(eventPayload),
      ],
    );
    await client.query(
      `insert into outbox_events
        (outbox_event_id, aggregate_type, aggregate_id, event_type,
         payload, correlation_id)
       values ($1, 'catalog_revision', $2,
               'CatalogRevisionActivated', $3::jsonb, $4)`,
      [
        randomUUID(),
        command.catalogRevisionId,
        JSON.stringify(eventPayload),
        command.correlationId,
      ],
    );

    return {
      activeCatalogRevisionId: command.catalogRevisionId,
      previousCatalogRevisionId: currentCatalogRevisionId,
    };
  });
}
