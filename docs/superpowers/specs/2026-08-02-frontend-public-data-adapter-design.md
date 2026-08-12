# Sprint 5B Frontend Public-Data Adapter Design

## Goal

Connect the public guide UI to the Sprint 5A read-only Publication API while preserving the current static GitHub Pages experience when the API is not configured, unavailable, or invalid.

## Approved decisions

- Use a client-side overlay adapter.
- Configure the API origin with `NEXT_PUBLIC_PUBLIC_API_BASE_URL`.
- Keep the existing static guide data as the immediate render and fallback.
- An active Publication replaces the matching champion's primary augment and item build.
- Keep the existing Vietnamese build title, summary, champion metadata, images, tips, traps, alternatives, and editorial source content.
- Add no Publication mutation, browser write, automatic publication, polling, timer, background refresh, cache, service worker, authentication, merge, or deployment behavior.

## Architecture

The exported page renders from the existing static `champions` collection. After browser hydration, `usePublicGuides` reads `NEXT_PUBLIC_PUBLIC_API_BASE_URL`. When configured, it performs exactly one `GET /api/v1/publications` request through `fetchPublications` and validates the complete closed response envelope before accepting any value.

The merge layer is pure and independent from React and network access. It indexes localized augment and item assets by their external IDs across the existing static guide catalog. Publications are grouped by normalized `championExternalId`; if more than one active Publication maps to the same champion, the deterministic winner is the newest `publishedAt`, then highest `versionNumber`, then lexicographically greatest `publicationId`.

A Publication overlays a champion only when:

- the Publication and payload pass closed schema validation;
- `schemaVersion` is exactly `1` at envelope and payload level;
- `mode` is exactly `aram_mayhem`;
- all authority identifiers and timestamps have the required primitive shapes;
- `championExternalId` maps to one existing champion;
- every augment and item external ID resolves to a localized static asset;
- at least one augment and at least two items are present;
- augment and item IDs contain no duplicates.

If any overlay requirement fails, that Publication is ignored and the affected champion remains fully static. One malformed record invalidates the closed API response rather than being silently accepted.

## Components

### `app/public-data/types.ts`

Defines the closed API and UI-state types:

- `PublicPublicationV1`
- `PublicPublicationListV1`
- `PublicDataStatus = "static" | "loading" | "live" | "fallback"`
- `PublicPublicationMetadata`

### `app/public-data/parse-publications.ts`

Exports `parsePublicPublicationList(input: unknown): PublicPublicationListV1`. The parser accepts exact known keys only and throws `PublicPublicationContractError` for malformed or expanded data.

### `app/public-data/http-publication-adapter.ts`

Exports:

```ts
fetchPublications(options: {
  apiBaseUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<PublicPublicationListV1>
```

It normalizes a single trailing slash from the base URL, requests only `/api/v1/publications` with method `GET`, accepts only HTTP 2xx JSON, and delegates all payload validation to the closed parser. It performs no retry.

### `app/public-data/merge-publications.ts`

Exports:

```ts
mergePublicationsIntoGuides(
  guides: readonly ChampionGuide[],
  publications: readonly PublicPublicationV1[],
): ChampionGuide[]
```

The function returns new objects only for champions with valid matching Publications. It preserves the static build title and summary, replaces `coreAugments`, `items`, and `itemData`, and attaches read-only `publicPublication` metadata containing Publication/version/patch/time identifiers.

### `app/public-data/use-public-guides.ts`

Exports `usePublicGuides(staticGuides, apiBaseUrl)`. Initial output is static. A configured URL produces `loading`, then `live` after a successful validated merge. Network, HTTP, JSON, schema, or merge failures produce `fallback` while retaining the original guides. The effect uses `AbortController` only for unmount cleanup and never schedules another request.

### `app/page.tsx`

Uses the hook's guide collection for metrics, search, filtering, cards, and the detail drawer. It displays one compact status line:

- no URL: `Dữ liệu tĩnh`;
- request in flight: `Đang kiểm tra bản xuất bản`;
- success: `Đang dùng bản xuất bản API`;
- fallback: `API tạm thời không khả dụng — đang dùng dữ liệu tĩnh`.

A champion whose primary build is overlaid displays a small `API · Bản <patchKey>` status pill and publication version/time metadata. Existing favorites remain local-only UI preferences and are unrelated to Publication mutation.

## Configuration and static export

`NEXT_PUBLIC_PUBLIC_API_BASE_URL` is optional. It is embedded by Next.js at build time for browser use. GitHub Pages builds without this variable and therefore make no API request and retain the current static output. Sprint 5B does not choose a backend deployment, proxy, CORS policy, or production URL.

## Error handling

- Missing configuration: static mode, no request, no warning.
- Non-2xx response: fallback mode.
- Invalid JSON or closed-schema mismatch: fallback mode.
- Unknown champion or unresolved asset IDs: ignore that Publication; other valid Publications still merge.
- Aborted request during unmount: no state update.
- No raw server error, URL credential, stack, or response body is rendered.

## Testing

Node 22 built-in tests run TypeScript with `--experimental-strip-types` and cover:

- closed list parsing and rejection of unknown keys;
- GET-only URL construction and non-2xx failure;
- deterministic Publication selection;
- successful localized augment/item overlay while preserving title and summary;
- unresolved ID fallback;
- no mutation method, retry, polling, timer, auto-publish, or browser credential behavior;
- page wiring and status copy;
- canonical GitHub Pages build succeeds with no API URL and retains the full static guide.

The repository's existing frontend validation, lint, rendered HTML tests, backend typecheck/tests/build, cleanliness checks, deployment guard, and dry-run-only deployment workflow remain required.

## Scope exclusions

- API deployment or production URL selection
- CORS expansion or reverse proxy
- server-side rendering from the API
- pagination, caching, polling, retry, live subscriptions, or service workers
- Publication create/update/delete/rollback endpoints or UI
- automatic publication or moderation behavior changes
- authentication, authorization, or secrets in the browser
- merge or deployment
