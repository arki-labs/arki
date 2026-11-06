# Agent guide: @arki/mcp

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/orpc.ts`, `src/contract.ts` and `src/tool.ts` win.

## The model

1. `asTool(procedure, mcp)` from `@arki/mcp/contract` copies an oRPC contract procedure and adds `meta.mcp`: a description, an `access`, an `effect` and optional name, budget, idempotence, remediation and `hidden`.
2. `fromRpc({ feature, contract, router }, { client })` from `@arki/mcp/orpc` builds one `McpTool` for each annotated leaf. The tool name is `<feature>_<procedure in snake case>`, or the `name` in the metadata.
3. A tool has `run` and `invoke`. `run(input, call)` returns the output or a failure value. `invoke(input, call)` returns the SDK `CallToolResult`.
4. `client(call)` returns the app gateway's native `ContractRouterClient`. Its root middleware and procedure guards stay in charge.
5. `ToolCall` is trusted host context: the principal, `signal`, result `budget`, delegated `scopes` and an optional `approve` hook.
6. The package does not serve MCP. It supplies the tools and the envelopes. The host owns the server, the tool list, JSON Schema conversion and OAuth.

## Task map

### Expose a procedure as a tool

1. Wrap the contract procedure: `asTool(oc.input(...).output(...), { description, access, effect })`.
2. A `destructive` effect needs `confirm: 'elicit'` or `confirm: { none: 'reason' }`.
3. A `remediation` key must name an error in the contract. A key that does not is a type error.

### Run the tools

1. `const tools = fromRpc({ feature: 'pizzeria', contract, router }, { client: () => client })`.
2. Build a `ToolCall` from the real request: principal, `signal`, `budget: { maxChars }`.
3. `await tools.pizzeria_order_status.run(input, call)` gives the output or a failure. Check it with `isFailure` from `@arki/failure`.
4. `await tools.pizzeria_order_status.invoke(input, call)` gives the `CallToolResult` for the SDK.

### Ask for approval

1. Mark the effect `destructive` with `confirm: 'elicit'`.
2. Pass `approve` in `ToolCall`. It gets the tool name, the input, the principal and the signal, and returns a boolean.
3. A missing `approve` or a `false` answer returns `mcp.approval_required`. The gateway does not run.

### Mount a child router

1. The child's adapter owns its tools. Pass the child's paths in `mountedPaths` so the parent skips them.
2. Pass `prefix` to rename the feature part of the tool names for a mounted instance.

## Rules that bite

- Only annotated leaves are tools. A leaf without `asTool` is absent from the registry.
- `access` is listing policy. The procedure middleware must authorize each call.
- Call the gateway client. Never call the feature router directly.
- A declared error on an exposed leaf must come from `errorMap(...)` of `@arki/failure/orpc`, and its code must match its key. Otherwise `fromRpc` fails to type check and throws a `TypeError` at build time.
- An invalid policy, a repeated tool name and a streaming output also throw a `TypeError` when `fromRpc` builds the tools.
- The size of a result counts the text and the structured content together. The call budget caps a tool budget.
- Output is not parsed again. Do not add a second parse in a tool.
- Match on the failure `code`, never on the message.
- The `./contract` entry has no server code. It is safe in a browser bundle.

## Errors

| Code                    | Meaning                                                    | What to do                                          |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `mcp.forbidden`         | The principal lacks the access, or the gateway refused it. | Use a principal with the required roles and scopes. |
| `mcp.approval_required` | The tool needs approval and the host did not give it.      | Get approval through the host and call again.       |
| `mcp.invalid_input`     | Input validation refused the arguments.                    | Correct the arguments.                              |
| `mcp.cancelled`         | The `signal` was aborted.                                  | Start a new call if the result is still needed.     |
| `mcp.result_too_large`  | The text plus the structured content is over `maxChars`.   | Ask for a smaller page.                             |
| `mcp.internal`          | The result is not JSON.                                    | Return serializable output from the procedure.      |

An error the contract does not declare becomes a scrubbed `UnexpectedDefect`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
