# Coolify connection (read-only)

Entry: `@arki/admin/connections/coolify`. Targets the Coolify **v4** REST API at `/api/v1` (`COOLIFY_SUPPORTED_MAJOR = 4`; `probeVersion()` reports unsupported majors). Needs only a `read` token. Never use `root`, `write` or `deploy` here.

Sources (read 2026-10-14):

- Auth and scopes: https://coolify.io/docs/api-reference/authorization
- `GET /applications`: https://coolify.io/docs/api-reference/api/operations/list-applications
- `GET /deployments`, `GET /deployments/applications/{uuid}?skip&take`: https://coolify.io/docs/api-reference/api/operations/list-deployments and `.../list-deployments-by-app-uuid`
- `GET /servers`: https://coolify.io/docs/api-reference/api/operations/list-servers
- `GET /version` (docs show `"v4.0.0"`; body parsed as JSON string or plain text): https://coolify.io/docs/api-reference/api/operations/version
- Webhook channel: https://coolify.io/docs/knowledge-base/notifications

## Known doc gaps

- The docs publish **no webhook payload schema and no signature**. `parseWebhookHint` is deliberately tolerant: it looks for `deployment_uuid`, `application_uuid`, `server_uuid` or `uuid`, plus `event`/`title` to guess the kind. Verify against a real delivery in S2 and adjust.
- The by-app deployments page shows application fields in its example. The schema accepts a bare array or `{ deployments: [...] }`.
- `GET /deployments/{uuid}`, `/applications/{uuid}` and `/servers/{uuid}` are used for confirmation; check they exist on the installed version.

## Flow

webhook -> (optional `verifyWebhookSecret`) -> `parseWebhookHint` -> `confirmHint` (API read) -> `CoolifySignal[]`. A hint for an unknown or healthy resource yields `[]`.

Fixtures in `fixtures/` are synthetic. Never record real instance data.
