# Action boundaries

`@arki/dot/action` declares browser-safe schemas, canonical failure references and
exposure policy. `@arki/dot/execute` binds server services separately. A descriptor
implements the existing `toDotAction()` protocol; it adds no registry.

```ts run expect
import { z } from 'zod';

import { action } from '@arki/dot/action';
import { bindAction } from '@arki/dot/execute';
import { defineFailure, isFailure } from '@arki/failure';

const Missing = defineFailure('catalog.missing', {
  status: 404,
  data: z.object({ id: z.string() }),
});
const lookup = action({
  id: 'catalog.lookup',
  input: z.object({ id: z.string() }),
  output: z.object({ title: z.string() }),
  failures: [Missing],
  policy: {
    exposure: ['http', 'rpc'],
    principal: 'optional',
    approval: 'none',
    retry: 'never',
  },
});
const bound = bindAction(lookup, input =>
  input.id === 'book' ? { title: 'Typed systems' } : Missing({ id: input.id }),
);
const result = await bound.run(
  { id: 'book' },
  {
    binding: 'http',
    principal: 'anonymous',
    approval: 'absent',
  },
);
if (isFailure(result)) throw new Error(result.code);
console.log(result.title);
```

```text
Typed systems
```

## Choose the validation owner

| Call                               | Input                                          | Successful output                      | Owner                                         |
| ---------------------------------- | ---------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| `bound.run(raw, invocation)`       | Unknown; input schema validates and transforms | Output schema validates and transforms | Action execution                              |
| `bound.handle(parsed, invocation)` | Already validated and transformed              | Output schema's **input** type         | Native transport validates and encodes output |

Use `handle` inside an oRPC handler or HTTP route whose native contract owns
validation. Calling `run` there applies transformations twice. HTTP codecs keep
request decoding separate from response encoding; they do not decode an already
parsed handler value again. Invalid server output becomes `UnexpectedDefect`.

## Two contract styles, one execution owner

A reusable descriptor (A) supplies schemas and `failures` directly to the adapter.
An independent native contract (B) selects its own schemas and canonical failures,
then passes those references to `bindAction`. Both execute inside the same
structured concurrency owner: children and resources settle before completion;
pass `signal` and `deadline` from the adapter. B may intentionally compose a
usecase into a different AI search input and output. Require parity only for the
same operation.

For RPC, use `errorMap(...lookup.failures)` on the contract,
`orThrowRpc(bound.handle(input, invocation), errors)` in its handler, and
`reviveRpcError(error, lookup.failures)` at the client. An independent contract
includes `ACTION_FAILURES` alongside its own exact canonical definitions.
Unknown codes and malformed known payloads revive as `InvalidEnvelope`.
Do not derive definitions from strings or restate a union of failure names.

HTTP keeps status codes and headers; RPC keeps its native error representation.
Auth adapters retain 404 masking, `WWW-Authenticate` and `Retry-After`. Adapter
validation, authorization, rate limits and idempotency add their own declared
failures; the business implementation's failure list is not their replacement.

## Authority and retries

`binding`, `principal` and `approval` are trusted adapter attestations. Never take
them from request JSON. Authenticate credentials and expiry before asserting
`authenticated`; verify approval bound to this caller, operation and input before
asserting `granted`. A job exposure grants no extra authority to an MCP tool.
Exposure, principal and approval checks apply before implementation execution.
`retry` is metadata for an explicit retry owner; neither action call retries.

An undeclared business failure is a compile error. Untyped callers returning one
are classified as `UnexpectedDefect` by the owner.

Sources: [descriptor](../src/action.ts), [execution](../src/execute.ts),
[RPC A/B fixture](../src/tests/action-rpc.test.ts),
[HTTP A/B fixture](../../http/src/tests/action-adapters.test.ts).
See [migration](./upgrade-actions.md) and [telemetry](./observability.md).
