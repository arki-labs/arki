# Coolify connection

Entry: `@arki/admin/connections/coolify`. Targets the Coolify **v4** REST API at `/api/v1` (`COOLIFY_SUPPORTED_MAJOR = 4`; `probeVersion()` reports unsupported majors). `createCoolifyClient` is read-only: give it a `read` token. `createCoolifyEnvWriter` is the only writer, kept apart so code holding the reader cannot write; give it a `write` token. Never use `root` or `deploy` here.

Sources (read 2026-10-14):

- Auth and scopes: https://coolify.io/docs/api-reference/authorization
- `GET /applications`: https://coolify.io/docs/api-reference/api/operations/list-applications
- `GET /deployments`, `GET /deployments/applications/{uuid}?skip&take`: https://coolify.io/docs/api-reference/api/operations/list-deployments and `.../list-deployments-by-app-uuid`
- `GET /servers`: https://coolify.io/docs/api-reference/api/operations/list-servers
- `GET /projects`, `GET /projects/{uuid}/environments` (read 2026-10-23 from the v4.x `openapi.yaml`, checked against Coolify 4.4.7): an application's `environment_id` is the `id` of an environment in one project's list. The docs give each environment a `project_id`, but 4.4.7 sends none, so name the project from the list you asked for. `GET /applications` also carries `base_directory`, `dockerfile_location` and `watch_paths`.
- `GET /version` (docs show `"v4.0.0"`; body parsed as JSON string or plain text): https://coolify.io/docs/api-reference/api/operations/version
- Webhook channel: https://coolify.io/docs/knowledge-base/notifications

## Known doc gaps

- The docs publish **no webhook payload schema and no signature**. `parseWebhookHint` is deliberately tolerant: it looks for `deployment_uuid`, `application_uuid`, `server_uuid` or `uuid`, plus `event`/`title` to guess the kind. Verify against a real delivery in S2 and adjust.
- The by-app deployments page shows application fields in its example. The schema accepts a bare array or `{ deployments: [...] }`.
- `GET /deployments/{uuid}`, `/applications/{uuid}` and `/servers/{uuid}` are used for confirmation; check they exist on the installed version.

## Env writer

`createCoolifyEnvWriter(...).write(applicationUuid, entries)` upserts variables with `PATCH /applications/{uuid}/envs/bulk`. Every entry is sent with `is_runtime: true`, `is_buildtime: false`, `is_preview: false`, `is_literal: true`, and `is_shown_once` for a `secret` entry.

Why it probes first: the bulk endpoint's documented body has no build-time flag, but the controller reads `is_runtime` and `is_buildtime` and makes a **new** variable both build-time and runtime when they are missing (`ApplicationsController::create_bulk_envs`, v4.x, read 2026-10-23). A version that does not know the field drops it silently. So the writer first stores `ARKI_ADMIN_RUNTIME_ONLY_PROBE`, checks the flags in the answer, and deletes it. Only then is a real value sent, and the stored flags are checked again.

Why it deletes preview copies: Coolify 4.4.7 copies every new variable into the application's preview environment, without `is_shown_once` (seen on a live instance, 2026-10-23). A production key must not reach PR previews unhidden, so after each write the writer lists the application's variables (`GET /applications/{uuid}/envs`, names and flags only) and deletes the preview copies of the keys it wrote. `removePreviewCopies(applicationUuid, keys)` does the same for variables written before.

It never reads values back: the answer is parsed with a strict schema that keeps `uuid`, `key` and the flags only. Errors carry the method, path and status, never a body, because a 422 can quote the submitted value.

## Flow

webhook -> (optional `verifyWebhookSecret`) -> `parseWebhookHint` -> `confirmHint` (API read) -> `CoolifySignal[]`. A hint for an unknown or healthy resource yields `[]`.

Fixtures in `fixtures/` are synthetic. Never record real instance data.
