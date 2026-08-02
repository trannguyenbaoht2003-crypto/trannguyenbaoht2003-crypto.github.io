# Frontend Public-Data Runbook

## Configuration

`NEXT_PUBLIC_PUBLIC_API_BASE_URL` is the optional browser-visible origin for the read-only Publication API. Configure it without `/api/v1/publications`; the adapter appends that path itself.

Examples:

```bash
NEXT_PUBLIC_PUBLIC_API_BASE_URL=https://public-api.example.com npm run build:pages
```

A GitHub Pages build without this variable remains fully static and makes no public API request.

## Read behavior

- The static champion guide is rendered immediately.
- When the variable is configured, the hydrated browser performs one `GET /api/v1/publications` request.
- The response must match the closed schema version `1` and `aram_mayhem` mode.
- A valid active Publication replaces only the matching champion's primary augment and item IDs after those IDs resolve to localized static assets.
- The Vietnamese title, summary, champion metadata, images, tips, traps, alternatives, and editorial source content remain static.
- When the request, JSON, schema, champion mapping, or asset mapping is unusable, the affected content stays static.
- The UI never renders raw server error details.

## Status meanings

- `Dữ liệu tĩnh`: no API URL is configured.
- `Đang kiểm tra bản xuất bản`: one read request is in progress.
- `Đang dùng bản xuất bản API`: the closed response was accepted.
- `API tạm thời không khả dụng — đang dùng dữ liệu tĩnh`: the request or response failed safely.

## Security and scope boundaries

- GET-only public read; no Publication mutation route or browser mutation call.
- No retry, polling, timer, background refresh, service worker, or subscription.
- No automatic publication or moderation behavior change.
- No browser token, authorization header, API credential, or authenticated write.
- No CORS expansion, reverse proxy, API deployment, or production URL selection.
- No merge or deploy in Sprint 5B.
