# ADR-0003 — Production Queue Backend: Aiven Valkey

- **Status: Accepted**
- **Date:** 2026-08-24
- **Scope:** Production BullMQ-compatible queue backend for Hải Đấu
- **Supersedes:** The production Redis-provider portion of ADR-0002; ADR-0002's Node.js/Fastify + PostgreSQL + BullMQ architecture remains accepted.

## Decision

Use **Aiven Valkey** as the production Redis-compatible delivery backend for BullMQ. Production application services continue to consume the connection through the existing `REDIS_URL` environment-variable contract so queue code, retry semantics, job identity, and worker boundaries do not change solely because the managed provider changed.

Production connections require TLS. The deployed secret must be the Aiven service URI using the TLS-capable `rediss://` scheme and must be stored only in Railway secret/environment configuration. No resolved URI, password, token, private service address, or credential may be committed to this repository or copied into release evidence.

## Context

ADR-0002 selected Node.js/Fastify + PostgreSQL + BullMQ/Redis. That decision deliberately treated Redis as replaceable delivery infrastructure rather than a source of domain truth. The production cutover on 2026-08-24 moved `backend`, `worker`, and the private inert `ai-automation` runtime from the legacy Railway Redis instance to managed Aiven Valkey while preserving the `REDIS_URL` interface.

`collector` does not require `REDIS_URL`. PostgreSQL remains the system of record for catalog, Candidate, Evidence, Human Review, Moderation, Eligibility, Publication, audit, and outbox state.

## Compatibility boundary

Valkey is used only as Redis-compatible queue/delivery infrastructure. The application continues to use BullMQ/ioredis through `REDIS_URL`; no Valkey-specific business authority is introduced.

- PostgreSQL remains domain and Publication authority.
- Public read remains independent from the queue backend and workers.
- Pending outbox work remains durable in PostgreSQL when Valkey is unavailable.
- Worker effects remain idempotent and replay-safe.
- AI automation remains private and inert by default; this ADR does not authorize provider execution or automatic publication.

## Local and CI policy

**Redis 7** remains the repository's local/CI compatibility fixture. `TEST_REDIS_URL=redis://127.0.0.1:6379` and GitHub Actions Redis 7 services are intentionally retained so automated tests do not require production credentials or an external Aiven dependency.

The production provider decision therefore does not require renaming `REDIS_URL`, `TEST_REDIS_URL`, BullMQ queues, or Redis-oriented error terminology that describes the compatibility protocol rather than the cloud provider.

## Operational requirements

1. Store the production Aiven connection URI as a secret; never commit it.
2. Use `rediss://` and require TLS for production connectivity.
3. Change `REDIS_URL` coherently across `backend`, `worker`, and `ai-automation` to avoid producer/consumer split-brain.
4. Keep the public read path independent from Valkey availability.
5. Monitor connection/authentication/TLS failures, queue processing health, and Valkey memory capacity.
6. Preserve `noeviction` semantics unless a separately reviewed capacity decision changes them; queue data must not be silently evicted under memory pressure.
7. Perform credential rotation after any credential exposure, then redeploy all Valkey consumers with the new URI and verify readiness/logs before invalidating the old credential.
8. Retire the legacy Railway Redis service only after all production consumers have been verified on Aiven Valkey.

## Current capacity caveat

The initial Aiven production service uses a single-node free plan. This is sufficient for the present low-volume production phase but is not high availability. Capacity, failover, and plan upgrades must be reviewed before queue throughput or operational criticality materially increases.

## Consequences

### Positive

- Removes the application queue backend from the legacy Railway Redis service.
- Keeps BullMQ/ioredis application code portable behind the existing environment contract.
- Preserves PostgreSQL/outbox recovery semantics and the public-read isolation boundary.
- Allows Redis 7 to remain a deterministic, credential-free local/CI fixture.

### Trade-offs

- Production queue connectivity now crosses providers and depends on public TLS reachability between Railway and Aiven.
- The current free Valkey plan is single-node and requires capacity monitoring.
- Credential lifecycle is managed separately from Railway-native service references.

## Rollback

If the Aiven Valkey connection becomes unusable during a cutover or credential rotation, restore a known-good Redis-compatible `REDIS_URL` coherently for all queue producers/consumers and redeploy them as one operational set. Do not change PostgreSQL state or Publication pointers merely to recover queue transport.

A rollback is complete only after application readiness succeeds, worker logs show no connection/auth/TLS loop, and public reads remain healthy.
