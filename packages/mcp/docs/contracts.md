# Contract annotations

`asTool(procedure, metadata)` from `@arki/mcp/contract` copies an oRPC contract,
retaining its input schema, output schema, error map and existing metadata, and
adds `meta.mcp`. This entry is browser-safe; it binds no implementation or server.

Supply `description`, `access` and `effect`. A destructive effect also requires
`confirm: 'elicit'` or an explicit `{ none: reason }`. `remediation` keys must name
errors in the contract. Optional names, budgets, idempotence and hidden metadata
are model-facing declarations, not authorization or retry execution.

`access` describes listing policy; procedure middleware must still authorize each
call. `hidden` is not a security boundary. A reusable Dot action's principal and
approval policies remain obligations for a trusted execution adapter.

Source: [contract.ts](../src/contract.ts). Type checks:
[contract.test-d.ts](../src/contract.test-d.ts).

## Executing through a gateway

`fromRpc(entry, { client })` from `@arki/mcp/orpc` builds executable tools from
explicitly annotated leaves. `entry` carries `{ feature, contract, router }`;
`client(call)` returns the app gateway's native `ContractRouterClient<typeof contract>`.
Use the gateway client so its root middleware, procedure guards and request context
remain the execution owners. The adapter never calls the feature router directly.
The optional `prefix` overrides the canonical feature name for mounted instances;
`mountedPaths` excludes child mounts owned by their own adapters.

Each tool retains the contract schemas and error map. `run(input, call)` returns
its inferred output or an exact canonical failure union; `invoke(input, call)`
converts that outcome to the SDK's `CallToolResult`. Canonical definitions attached
by `@arki/failure/orpc`'s `errorMap` survive contract composition and revive known
RPC errors with checked data. Every declared error on an executable exposed leaf
must come from canonical `errorMap(...)` definitions whose codes match their map
keys; missing or mismatched references fail both type checking and construction.
Empty error maps are valid. Hidden and unannotated leaves do not impose this
execution requirement. Unknown errors become scrubbed defects. Native
client validation applies output transforms once; the adapter does not parse
successful output again.

The native client capability deliberately replaces the initial plan's untyped
`call(path, input): Promise<unknown>` hook. An unknown result cannot safely become
a typed success, and reparsing its output would apply schema transforms twice.

The trusted `ToolCall` contains the principal, delegated scopes, cancellation
signal, result budget and optional approval authority. Missing access or required
approval fails closed before gateway execution. `confirm: 'elicit'` requires the
host's `approve` hook; that hook must enforce the application's approval rules.
The adapter does not claim one-use, durable or replay-safe approval semantics.
A `confirm: { none: reason }` declaration explicitly waives that tool's elicitation.

Hidden leaves are excluded, duplicate names and streaming outputs are rejected,
and oversized results become a canonical `mcp.result_too_large` error envelope.
The trusted call budget caps any tool-specific budget; the size includes both
text and serialized structured content. Error envelopes remain actionable when
the available budget is smaller than the failure message.
This slice supplies callable tools and SDK-compatible envelopes; it does not
supply the MCP server, principal-filtered tool listing, JSON Schema conversion,
OAuth, Dot plugin or durable approval engine. Hosts own those later integrations.

Runtime evidence: [orpc.test.ts](../src/orpc.test.ts), including gateway middleware,
owner context, exact business failures, access/approval denial and an SDK call.
