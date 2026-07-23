# Sprint 1B-A — Cloudflare Correctness Adapter

Spike-only implementation for Cloudflare Worker + D1 + Cloudflare Queues.

This branch starts from the locked Common Harness SHA:

`dc8deebb478cc5892304662e14dbf8b07ecd1627`

The adapter must implement the common contract, execute T1–T9 and S1–S24, and export the same evidence formats as the common harness. It is not production code and must not deploy remote resources.

## Safety

- Local Wrangler/Miniflare only.
- No production credentials or resources.
- No public API.
- No production migrations.
- No changes to Domain Spec or Evidence/moderation policy.
- No merge into `main`.

