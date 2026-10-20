# @arki/mcp

MCP servers and MCP Apps for ARKI. Unreleased (`"private": true`) until slice 7 of [the plan](../../docs/plans/2026-10-17-arki-mcp.md) writes the agent docs. This file records the facts slice 0 measured; later slices build on them.

## Runtimes

Measured 2026-10-17 by `bun run test:runtimes` (`scripts/smoke.mjs`: `createMcpHandler` from `@modelcontextprotocol/server` 2.3.1 answers `initialize`, `tools/list` and `tools/call` as plain `Request` → `Response`) and by `src/handler.probe.test.ts` (the official client 2.3.1 wired into `handler.fetch`, no socket).

| Leg | Result |
| --- | --- |
| node | pass (smoke and probe) |
| bun | pass (smoke and probe, `bun --bun vitest run`) |
| deno | pass (bundled, because Deno cannot read `catalog:` versions) |
| browser | out of scope for the root entry. The SDK calls `crypto.randomUUID`, which a browser only has on a secure origin, and the harness page is not one. A server does not run in a tab. `./contract` (slice 3) must bring this leg back. |
| hermes | out of scope; a server does not run on React Native |

Protocol eras: a client pinned to `2026-07-28` negotiates the modern era; a default client negotiates `2025-11-25` through the handler's built-in `legacy: 'stateless'` fallback. No separate legacy server package is needed.

## OAuth tables

`@better-auth/mcp` 1.7.10 owns no tables. It wraps `@better-auth/oauth-provider` 1.7.10, whose schema (`dist/authorize-*.mjs`, `const schema`) defines seven models. `jwt()` adds `jwks`. `@better-auth/cimd` 1.7.10 (the 2026-07-28 Client ID Metadata Document flow) adds none.

| Model | Required fields | References |
| --- | --- | --- |
| `oauthClient` | `clientId`, `redirectUris` | `userId` → `user` |
| `oauthResource` | `identifier`, `name` | — |
| `oauthClientResource` | `clientId`, `resourceId`, `createdAt` | `oauthClient`, `oauthResource` |
| `oauthRefreshToken` | — | `clientId` → `oauthClient`, `sessionId` → `session`, `userId` → `user` |
| `oauthAccessToken` | `clientId`, `scopes` | `oauthClient`, `session`, `user`, `refreshId` → `oauthRefreshToken` |
| `oauthConsent` | `clientId`, `scopes`, `updatedAt` | `oauthClient`, `user` |
| `oauthClientAssertion` | `expiresAt` | — |

Slice 5 generates the Drizzle tables from the installed package, not from this table. Better Auth's guidance: serve the MCP route with `legacy: 'reject'` behind `requireMcpAuth`, `POST` only; Dynamic Client Registration is off unless enabled.
