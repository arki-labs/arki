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

UUID-v4 domains use the same declaration and failure union:

```ts run
import { defineId } from '@arki/contracts';
import { orThrow } from '@arki/failure';

const jobId = defineId('', { kind: 'queue.job', format: 'uuid' });
const generated = orThrow(jobId.create());
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generated)) {
  throw new Error('Expected UUID v4');
}
if (jobId.schema.parse('customer:job/42') !== 'customer:job/42') throw new Error('External key changed');
```

`format` controls generation only; schemas keep prefix-only validation so explicit
external job keys remain valid. Existing UUID bytes are unchanged. Native Web
Crypto `randomUUID` takes precedence. If it is not callable, generation uses
16 secure bytes from `getRandomValues`, setting the
[RFC 9562 UUID-v4 version and variant bits](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.4). Missing both providers returns `RandomSourceUnavailable`; thrown
faults, invalid output and asynchronous protocol violations return
`UnexpectedDefect` with private causes. A broken available native UUID provider
never triggers a fallback. `create()` retains its exact canonical failure union.
Omitting format preserves the existing 24-character generation algorithm.

Existing nanoid-style values can retain their exact stored alphabet and length:

```ts run
import { defineId } from '@arki/contracts';
import { orThrow } from '@arki/failure';

const recordId = defineId('', {
  kind: 'offline.idempotency-record',
  format: { alphabet: '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', length: 21 },
});
const lowerId = defineId('', {
  kind: 'legacy.lower-id',
  format: { alphabet: '0123456789abcdefghijklmnopqrstuvwxyz', length: 21 },
});
if (!/^[_\-\da-zA-Z]{21}$/.test(orThrow(recordId.create()))) throw new Error('Nanoid format changed');
if (!/^[\da-z]{21}$/.test(orThrow(lowerId.create()))) throw new Error('Lowercase format changed');
```

Choose the alphabet order and length used by the existing generator. Each output
position is uniformly sampled from that alphabet, including the first; this
preserves the distribution of a uniform nanoid generator without a generator hook.
Formats require 2–256 distinct non-surrogate UTF-16 characters and an integer
length of 1–256. Characters outside the BMP are rejected because each output
position must occupy one UTF-16 code unit. Invalid formats (including extra keys)
throw `ContractsError` with `ARKI_CONTRACTS_E010` at definition time. The format
is copied and frozen; mutating the supplied object later cannot change output.

Custom generation uses the same supervised Web Crypto byte provider and exact
`IdGenerationFailure` union. Rejection sampling runs at most 32 batches of twice
the requested length (up to 16,384 bytes total). Missing providers return
`RandomSourceUnavailable`; thrown faults, different/detached buffers,
asynchronous output or an exhausted budget return `UnexpectedDefect`. Stored
schema validation stays prefix-only; formatting generation does not invalidate
older or externally assigned keys.

An application on a runtime without Web Crypto must initialize its own provider
backed by secure platform entropy before generation. It must fail closed when
secure entropy is unavailable in every supported mode, including debugging. A
secure byte provider supports UUID generation even without `randomUUID`. Contracts
checks the synchronous provider protocol; it cannot certify entropy quality from
returned bytes. It does not install global polyfills or use weak randomness.
Missing providers return `RandomSourceUnavailable`; a provider that throws when
entropy is unavailable returns `UnexpectedDefect` with its private cause.
