# Sprint 1B-B — PostgreSQL + BullMQ Correctness Adapter

Spike-only implementation for Node.js, Fastify, PostgreSQL, BullMQ and Redis.

This branch starts from the locked Common Harness SHA:

`dc8deebb478cc5892304662e14dbf8b07ecd1627`

The adapter must implement the same common contract, T1–T9, S1–S24, F01–F12 and evidence bundle contract used by Platform A. It is not production code and must not deploy remote resources.

## Safety

- GitHub Actions service containers only.
- No production database or Redis credentials.
- No public API deployment.
- No production migrations.
- No changes to Domain Spec or Evidence/moderation policy.
- No merge into `main`.

