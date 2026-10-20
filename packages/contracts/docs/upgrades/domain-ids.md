# Domain ID types

Use one browser-safe declaration for each domain kind:

```ts run
import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';

export const refundId = defineId('id_', { kind: 'billing.refund' });
export const paymentId = defineId('id_', { kind: 'billing.payment' });
export type RefundId = IdOf<typeof refundId>;
export type PaymentId = IdOf<typeof paymentId>;

const restored: RefundId = refundId.schema.parse('id_existing');
if (String(restored) !== 'id_existing') throw new Error('Stored ID changed');
```

The brand is defined once on the canonical schema. `IdOf`, `create`, `is`, DB
columns and contracts infer it. Generation still returns the exact
`IdGenerationFailure` union. A payment ID and a raw string cannot satisfy a
`RefundId` parameter. One literal `kind` names one domain; widened strings and
unions are rejected. Reuse the declaration wherever that domain is shared.

The prefix and suffix validation stay unchanged. Existing rows need no rewrite,
and serialization produces the same string. Validate deserialized input with the
owning schema. A brand is a TypeScript distinction: when two domains use the same
format, their schemas both accept the same bytes. The owning route, operation or
field determines which schema to apply; authorization still checks ownership.
`assertUniqueIdPrefixes` continues to reject overlapping wire formats.

On the server, use `idColumns(refundId)` from `@arki/db/id`. Select and insert
columns retain the brand. When constructing table validators, use the canonical
schema refinement (`{ id: () => refundId.schema }`) for exact static schema
inference as well as runtime validation.

The existing `defineId(prefix)` form retains its prefix-only output type so
migrations can proceed one domain and its consumers at a time. Add the kind at the
declaration, then replace copied string aliases with `IdOf`. Parse actual raw
boundaries; do not cast strings or reparse already typed application values to
silence type errors. Update successful test fixtures through the schema or checked
generator, keeping deliberate refusal assertions intact.

External and numeric IDs use their provider's canonical validator and a brand;
they do not need an Arki generator:

```ts run
import type { IdOf } from '@arki/contracts';
import { z } from '@arki/contracts';

export const providerUserId = { schema: z.number().int().positive().brand<'provider.user'>() };
export type ProviderUserId = IdOf<typeof providerUserId>;
const id: ProviderUserId = providerUserId.schema.parse(42);
if (id !== 42) throw new Error('Provider ID changed');
```

Apply the same schema-first pattern to meaningful domain strings. Free text and
existing literal unions do not need invented identity brands.
