# @arki/mcp

MCP servers and MCP Apps for ARKI. It turns the procedures of an oRPC contract into MCP tools and keeps their middleware, so a tool call passes the same checks as an HTTP call. This file also records the facts the first slice measured about runtimes and the OAuth tables.

## Install

```sh
npm install @arki/mcp
# or
bun add @arki/mcp
# or
pnpm add @arki/mcp
```

`@arki/mcp/orpc` runs a router through its gateway client, so install `@orpc/server` in the app that serves the tools.

## Quick start

Mark a contract procedure as a tool with `asTool`. Then build the executable tools with `fromRpc`, and call one with a trusted `ToolCall`.

```ts
import { createRouterClient, implement } from '@orpc/server';
import { oc } from '@orpc/contract';
import { z } from 'zod';

import { asTool } from '@arki/mcp/contract';
import { fromRpc } from '@arki/mcp/orpc';
import type { ToolCall } from '@arki/mcp';

const orderStatus = asTool(oc.input(z.object({ id: z.string() })).output(z.object({ status: z.string() })), {
  description: 'Read the status of one pizza order.',
  access: 'public',
  effect: 'read',
});
const contract = { orderStatus };
const root = implement(contract);
const router = root.router({ orderStatus: root.orderStatus.handler(({ input }) => ({ status: `${input.id}: baking` })) });
const client = createRouterClient(router);

// The tool name is `<feature>_<procedure in snake case>`: `pizzeria_order_status`.
const tools = fromRpc({ feature: 'pizzeria', contract, router }, { client: () => client });

// The host builds this from the real request. None of it comes from the tool arguments.
const call: ToolCall = { principal: null, signal: new AbortController().signal, budget: { maxChars: 8000 } };

export const result = await tools.pizzeria_order_status.invoke({ id: 'ord_42' }, call);
// { content: [{ type: 'text', text: '{"status":"ord_42: baking"}' }], structuredContent: { status: 'ord_42: baking' } }
```

## When not to use this

- You need the MCP server itself: the transport, a principal-filtered tool list, JSON Schema conversion or the Dot plugin. This package gives callable tools and `CallToolResult` envelopes. The host wires the server.
- Your API is not an oRPC contract. `fromRpc` reads contracts and routers.
- You want a tool to be the security boundary. `access` and `hidden` describe listing. The procedure middleware must still authorize each call.

## Runtime support

Measured 2026-10-17 by `bun run test:runtimes` (`scripts/smoke.mjs`: `createMcpHandler` from `@modelcontextprotocol/server` 2.3.1 answers `initialize`, `tools/list` and `tools/call` as plain `Request` → `Response`) and by `src/handler.probe.test.ts` (the official client 2.3.1 wired into `handler.fetch`, no socket).

Notes on the table below (the node and bun results are in it and in the smoke and the probe):

- deno passes bundled, because Deno cannot read `catalog:` versions.
- browser is out of scope for the root entry. The SDK calls `crypto.randomUUID`, which a browser only has on a secure origin, and the harness page is not one. A server does not run in a tab. `./contract` (slice 3) must bring this leg back.
- hermes is out of scope; a server does not run on React Native.

Protocol eras: a client pinned to `2026-07-28` negotiates the modern era; a default client negotiates `2025-11-25` through the handler's built-in `legacy: 'stateless'` fallback. No separate legacy server package is needed.

<!-- runtimes:start -->
| Runtime | Result | Version tested | Date (UTC) |
| --- | --- | --- | --- |
| node | pass | v22.13.1 | 2026-11-05 |
| bun | pass | 1.4.2 | 2026-11-05 |
| deno | pass | 2.9.8 | 2026-11-05 |
| browser | n/a | - | 2026-11-05 |
| hermes | n/a | - | 2026-11-05 |
<!-- runtimes:end -->

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

## Public imports

| Import                | What it holds                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/mcp`           | Types only: `Access`, `Effect`, `McpTool`, `ToolCall`, `ToolName`.                                                                                             |
| `@arki/mcp/contract`  | `asTool`, which adds `meta.mcp` to a contract procedure. Browser-safe. Type `McpMeta`.                                                                         |
| `@arki/mcp/orpc`      | `fromRpc`, the failure constructors and `ADAPTER_FAILURES`. Types `RpcTools`, `Snake`.                                                                         |

## Failure behaviour

`McpTool.run` returns its output or a failure value. It does not throw for a refused call. `McpTool.invoke` turns the same outcome into a `CallToolResult` with `isError: true` and the text `code: message remediation`.

| Code                     | Failure            | When                                                                   |
| ------------------------ | ------------------ | ---------------------------------------------------------------------- |
| `mcp.forbidden`          | `Forbidden`        | The principal lacks the required access, or the gateway refused it.    |
| `mcp.approval_required`  | `ApprovalRequired` | The tool needs approval and the host `approve` hook is missing or said no. |
| `mcp.invalid_input`      | `InvalidInput`     | Input validation refused the arguments.                                |
| `mcp.cancelled`          | `Cancelled`        | The call was cancelled through its `signal`.                           |
| `mcp.result_too_large`   | `ResultTooLarge`   | The text plus the structured content is longer than `maxChars`.        |
| `mcp.internal`           | `InvalidResult`    | The result is not JSON.                                                |

A declared contract error comes back as its own canonical failure. An unknown error becomes a scrubbed `UnexpectedDefect`. `fromRpc` throws a `TypeError` while it builds the tools when a policy is invalid, a tool name repeats, an output streams, or a declared error has no canonical definition.

## Limits

- A result is capped by `ToolCall.budget.maxChars`. A tool `budget` can only be smaller. The size counts the text and the structured content together.
- Streaming outputs are rejected.
- `confirm: 'elicit'` calls the host `approve` hook. The adapter does not claim one-use, durable or replay-safe approval.
- Tool names match `<feature>_<name>`: a lower-case prefix, an underscore, then the rest.
- Runtimes: Node, Bun and Deno. See the table above.

## Documentation

- [Contract annotations](docs/contracts.md): `asTool`, `fromRpc`, the trusted `ToolCall` and the result envelope.
- [Agent guide](docs/agent-guide.md): the model, the task map, the rules and the errors.
- [llms.txt](llms.txt): the import map for agents.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version and the failure `code`.
