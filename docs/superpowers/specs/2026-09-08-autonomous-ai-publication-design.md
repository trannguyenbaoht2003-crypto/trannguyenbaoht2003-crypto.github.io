# Autonomous AI review and publication

Status: accepted by owner delegation on 2026-09-08.

## Objective and authority

The owner requested AI to review and update Hải Đấu automatically, and delegated routine implementation and release decisions. This explicitly supersedes the earlier human-only publication requirement for policies that select AI review. Historical human review records remain truthful and unchanged. Discovery output itself is never evidence.

## Design

Use the existing claim, evidence, moderation, eligibility, publication and rollback graph. Extend review policies with an explicit human or AI authority. AI receipts live in their own immutable table. The generic review quorum can count a verified AI receipt only under an AI policy; human policies continue to count only human reviews. SQL constraints enforce this separation, including direct SQL writes.

The private AI worker processes current catalog candidates. For newly collected candidates it may seal a narrow community-report claim: the exact normalized build selection was reported in public sources. This is not an effectiveness, win-rate or official recommendation claim. At least two distinct public source hosts must support the same normalized candidate, with current patch/catalog and no AI-generated evidence. The model checks the supplied evidence and all required claims; it can confirm, request changes, or decline. Missing sources, contradictory claims, stale input, invalid output and provider errors prevent publication.

Provider input is bounded structured data, with public references and allowed normalized observations only. Source text is untrusted data, never instructions. Output must cite supplied observations, cover every required claim, and match a strict schema. A model score alone cannot authorize publication.

AI review binds the exact claim/evidence/provenance snapshot, model, prompt version, request/response hashes, provider response identifier and result. Publication reuses the current eligibility and moderation checks. A changed snapshot requires a new review. Every write is idempotent and journaled; an uncertain provider call is not automatically replayed.

## Runtime

AI_AUTONOMOUS_PUBLICATION_ENABLED defaults to false. Enabling requires an API key and explicit model configuration. A separate hourly job processes at most one candidate per tick, reserves at most four model calls per UTC day, and caps each response at 4096 tokens. Database reservations serialize concurrent workers and survive restarts. Completed provider results are resumed without another paid request. Publication IDs derive from the durable run ID.

The worker may bootstrap a versioned AI review/eligibility policy when explicitly enabled. Disabling the scheduler stops new calls; policy reversal and existing publication rollback remain available. No public mutation route or frontend secret is introduced.

## Verification and release

Tests must prove authority separation, no invented human review, exact source/claim validation, stale-input rejection, idempotency, daily budget concurrency, uncertain-call handling and review-to-publication integration. Existing human publication and rollback tests must continue to pass.

The OpenAI connector currently rejects both encrypted-key creation and target discovery. No key was created. Code and disabled deployment can proceed; real AI activation requires a restored Platform connection and a verified first run. Do not claim live automation before that evidence exists.
