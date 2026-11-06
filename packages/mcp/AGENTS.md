AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/mcp

Tools for MCP servers, built from oRPC contract procedures. When a doc and the code disagree, `src/orpc.ts`, `src/contract.ts` and `src/tool.ts` win.

## Laws

1. A procedure is a tool only when `asTool` marked it. Nothing is exposed by default.
2. `access` and `hidden` describe listing. The procedure middleware authorizes every call, and `hidden` is not a security boundary.
3. Tools run through the gateway client, so root and procedure middleware stay the owners. The adapter never calls the feature router directly.
4. A refused call returns a failure value (`mcp.forbidden`, `mcp.approval_required`, `mcp.invalid_input`, `mcp.cancelled`, `mcp.result_too_large`, `mcp.internal`). It does not throw.
5. Missing access or missing approval fails closed before the gateway runs.
6. Every declared error on an exposed tool must come from a canonical `errorMap(...)` definition whose code matches its key.
7. Successful output is not parsed a second time. The native client already applied the output transforms.
8. `ToolCall` is trusted host context. No field of it comes from tool arguments.
9. This package owns no tables and no MCP server. The OAuth tables belong to `@better-auth/oauth-provider`.
10. Every error code has JSDoc with a summary, `@fix` and `@verify`.
11. Logs go through `getLogger('arki:mcp')`. Never `console.log`.
12. Types are written once and inferred everywhere. `policy.test-d.ts` locks `mcpPolicySchema` to `McpMeta` in both directions.
13. A public export is never deleted because nothing uses it. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. They run in `bun run test:docs`.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
