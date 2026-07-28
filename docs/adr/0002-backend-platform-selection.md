# ADR-0002 — Backend Platform Selection

- **Status:** Accepted
- **Date:** 2026-07-23
- **Approved:** 2026-07-23
- **Decision owner:** Trần Nguyên Bảo
- **Prepared by:** Product Owner / Software Architect / Senior Full-stack Engineer / QA / Release Manager
- **Scope:** Production backend platform for Hải Đấu
- **Related:** Architecture Baseline v0.2; Data Model Domain Spec v0.2; Evidence Contract 1B-C-v2
- **Previous state:** Deferred after the v1 evidence audit

## Decision

Select **Platform B: Node.js/Fastify + PostgreSQL + BullMQ/Redis** as the production backend and system of record for Hải Đấu.

Keep the current web frontend independently deployable. Cloudflare may still be used later for DNS, CDN, static delivery, caching, or a thin edge gateway, but D1 and Cloudflare Queues will not be the primary production database and job system.

The decision owner explicitly approved Option B on 2026-07-23. This approval finalizes the backend architecture only:

- neither spike is approved for merge as production code;
- no production deployment is authorized;
- no production database, Redis instance, queue, credential, or migration may be created without the applicable implementation and release gates.

## Decision drivers

Hải Đấu needs more than a request/response website. Its target backend must support:

1. scheduled and event-driven collection of Chinese game-meta sources;
2. rate-limited crawling, retries, dead-letter handling, and large backfills;
3. normalization, deduplication, evidence association, AI classification, and moderation workflows;
4. durable audit history and immutable publication versions;
5. relational integrity across sources, observations, candidates, claims, reviews, moderation decisions, and publications;
6. operational recovery without allowing AI to publish autonomously.

Both candidates satisfy the approved correctness contract. The decision therefore turns on long-term product fit and operating model, not on test pass counts.

## Evidence reviewed

| Item | Platform A — Cloudflare | Platform B — PostgreSQL/BullMQ |
|---|---|---|
| Draft PR | [#6](https://github.com/trannguyenbaoht2003-crypto/trannguyenbaoht2003-crypto.github.io/pull/6) | [#7](https://github.com/trannguyenbaoht2003-crypto/trannguyenbaoht2003-crypto.github.io/pull/7) |
| Durable head SHA | `88e65eba44cab11180ecd5a3cf3ba7ab56270e50` | `02d5c9319c61742549cc4483f2b8a162d3e95e1e` |
| Artifact merge SHA | `404f7ebc94ac75ac9a3264d894fb48aec6b75942` | `4837dbf0ce705d3aba456c2972022b9ee6f3deae` |
| Common Harness SHA | `65e5ad092f40ef232041967a1a13160bd4ada834` | Same |
| Fixture checksum | `4f0310375a872d376efc80578e7524d2479c66970887370beaea2a13e2b08b93` | Same |
| Materialized fixture records | 12,011 | 12,011 |
| S1–S24 | 24/24 PASS | 24/24 PASS |
| F01–F12 | 12/12 runner-backed | 12/12 runner-backed |
| JUnit scenarios | 24 PASS, 0 failure | 24 PASS, 0 failure |
| Three full-suite runs | 27/27 PASS each | 26/26 PASS each |
| Mean full-run duration | 9.813 s | 10.048 s |
| Audit mutations | 222 | 222 |
| Outbox events | 221 total / 6 delivered | 221 total / 6 delivered |
| Duplicate side effects | 0 | 0 |
| Restore | PASS | PASS |
| Immutable versions | PASS; 0 mutated rows | PASS; 0 mutated rows |
| ZIP SHA-256 | `e55b606a3cd2cdda0ce83728bb3bedeb64adfa690289254b10d172a17b21f1f6` | `6985254cde1be8812977a6501c5c63ecdec866277e113b7e326b911dfc9d0167` |

The independent v2 validator accepted both bundles with 24 scenarios and 12 failure points. Both ZIP archives passed integrity checks. All workflows associated with the two durable head commits completed successfully.

The 2.4% difference in mean test duration is not a performance result: the sample is only three CI runs, the adapters have different setup/teardown work, and the spike was designed for correctness rather than load testing.

## Cross-platform consistency note

Twenty-three scenario snapshots have matching canonical after-checksums. S6 differs only in observed asynchronous consumer timing:

- Cloudflare captured one consumer effect before the snapshot;
- PostgreSQL/BullMQ captured zero before the snapshot;
- both produced the same domain counts and passed the two S6 assertions: supported evidence remains supported, while blocked moderation keeps the candidate ineligible.

This does not reverse either correctness result, but production tests must define a queue-quiescence barrier whenever a scenario asserts eventual projection state.

## Architecture fit score

This is a weighted architecture assessment, not a benchmark or vendor price quote.

| Criterion | Weight | Platform A | Platform B |
|---|---:|---:|---:|
| Domain correctness and invariants | 30 | 30 | 30 |
| Crawler, AI, retry, concurrency, and backfill flexibility | 25 | 17 | 25 |
| Audit data growth, relational queries, and schema evolution | 20 | 12 | 20 |
| Operational simplicity | 15 | 15 | 8 |
| Portability and vendor independence | 5 | 2 | 5 |
| Early-stage infrastructure cost | 5 | 5 | 3 |
| **Total** | **100** | **81** | **91** |

## Why Platform B is recommended

### 1. Better fit for durable relational state

The domain is relation-heavy and audit-heavy. PostgreSQL provides mature concurrency control, unique and foreign-key constraints, declarative partitioning, and extensive operational tooling. These characteristics match long-lived observations, claims, moderation histories, publication versions, and audit events.

Official references:

- [PostgreSQL concurrency control](https://www.postgresql.org/docs/current/mvcc.html)
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL table partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

### 2. Better fit for autonomous collection and AI pipelines

BullMQ supports worker concurrency, retries, backoff, rate limiting, and distributed job processing. Node workers can also run source-specific parsers, browser automation, translation, AI calls, and controlled backfills without forcing every stage into an edge-isolate execution model.

Official references:

- [BullMQ workers](https://docs.bullmq.io/guide/workers)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [BullMQ concurrency](https://docs.bullmq.io/guide/parallelism-and-concurrency)

### 3. More headroom for centralized history

D1 remains a credible choice for smaller edge-oriented applications, but each D1 database has a fixed 10 GB paid-plan limit and processes queries one at a time. Cloudflare recommends horizontal scale through multiple smaller databases. That model would require sharding and cross-shard operational design earlier than Hải Đấu needs.

Workers and Queues are capable, but their isolate and invocation limits still shape crawler and AI job design: Workers have 128 MB memory; paid CPU can be configured up to five minutes; queue consumers have a 15-minute wall-clock limit. These constraints are manageable, but they create extra decomposition work for browser-heavy collection and large backfills.

Official references:

- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)

### 4. The operating cost is acceptable if services are managed

Platform B has more moving parts. The production design should therefore use managed PostgreSQL and managed Redis, infrastructure-as-code, automated backups, point-in-time recovery, health checks, queue metrics, structured logs, and a tested restore runbook. PostgreSQL remains the source of truth; Redis/BullMQ is replaceable delivery infrastructure, and outbox events must be replayable.

## Alternatives

### Option A — Select Cloudflare Worker + D1 + Queues

Choose this only if minimizing infrastructure operations and early cost is more important than crawler flexibility and centralized data headroom.

Consequences:

- simplest serverless operating model;
- strong global edge integration;
- earlier exposure to D1 sharding, per-database throughput, Workers runtime limits, and deeper Cloudflare coupling;
- browser-heavy or long-running jobs may need a separate execution service later.

### Option B — Select Node/Fastify + PostgreSQL + BullMQ/Redis

**Recommended.**

Consequences:

- best fit for the planned ingestion, AI, audit, and backfill workload;
- strongest relational and operational flexibility;
- requires managed services, monitoring, backup/restore, patching, and queue operations;
- permits Cloudflare to remain an edge delivery layer without making it the system of record.

### Option C — Defer and run a performance/cost/reachability spike

Choose this only if the owner is unwilling to accept a fit-based decision without measured production-like workload.

The next spike would measure source reachability, browser-automation compatibility, sustained ingestion, p95 latency, backfill duration, recovery time, and monthly cost. This would improve cost/performance confidence but delay the backend implementation. It is not required to establish correctness, because both v2 bundles already passed that gate.

## Invariants preserved

This ADR does not change the Architecture Baseline, Domain Spec, Evidence policy, or moderation policy.

- AI may collect, normalize, deduplicate, score, translate, classify, and recommend.
- AI cannot grant itself publication authority.
- An AI-origin candidate cannot publish without the approved human-review and publisher-authority requirements.
- Missing moderation is never interpreted as clear.
- Publication versions remain immutable.
- Outbox delivery and consumers remain idempotent.
- Spike code is not production code.

## Production implementation boundaries

1. create a new implementation branch from `main`, not from either spike branch;
2. translate the approved Domain Spec into production PostgreSQL migrations and repository contracts;
3. implement the outbox dispatcher and BullMQ workers behind interfaces proven by the Common Harness;
4. add source adapters for approved Chinese data sources with rate limits, provenance, and retention policy;
5. add AI moderation as a recommendation stage that cannot call publication commands;
6. add observability, secrets management, backup/restore, and disaster-recovery tests;
7. run correctness, security, load, and recovery gates before requesting any production deployment;
8. keep PR #6 and PR #7 unmerged as spike evidence unless a separate cleanup decision is approved.

## Known documentation cleanup

The two adapter README files still name the earlier harness SHA `dc8deebb478cc5892304662e14dbf8b07ecd1627`, while the v2 branches and bundles use `65e5ad092f40ef232041967a1a13160bd4ada834`. This stale text does not change the artifact lineage, because both PR heads are verified descendants of the v2 harness, but it must be corrected before archiving the spikes.

The bundle manifests record the pull-request merge SHAs generated by GitHub Actions. The durable source references for future reproduction are the PR head SHAs listed in the evidence table.

## Approval record

- **Approved option:** Option B — Node/Fastify + PostgreSQL + BullMQ/Redis.
- **Approved by:** Trần Nguyên Bảo.
- **Approval date:** 2026-07-23.
- **Authorization scope:** Backend architecture selection only.
- **Merge/deployment authorization:** None.
- **Next action:** Begin the production-foundation Sprint from `main` on a new implementation branch.
