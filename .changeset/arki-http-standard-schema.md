---
'@arki/http': minor
---

Contracts take any Standard Schema (zod, valibot, arktype, hand-written), not only zod.

- Breaking: `params`, `headers` and `query` are records with one field per key (`{ id: OrderId }`), not one `z.object`. A field is a schema, a `codec()`, or `optional(...)` around either; the `optional` marker decides `?:` and a missing optional key reaches the handler as `undefined`.
- Breaking: a bare schema is its own encoder. Two-way fields (ISO string <-> `Date`) use the new `codec(decode, encode)`, whose pair must reverse each other's types; a zod `z.codec` inside a bare schema no longer encodes.
- Breaking: an optional path placeholder (`:x?`) needs an `optional(...)` field and vice versa, checked at declaration (E011).
- Breaking: a 400 now lists every failing field as `where.key: message` (`request validation failed: query.page: …`); a schema that throws answers 500.
- Breaking: removed `SchemaLike`, `HeaderSchema`, `ParamSchema`; `RouteInput` moved to the contract types; `ResponseSchemas` holds `Wire` values.
- Breaking: OpenAPI and manifest JSON Schema come from each schema's `~standard.jsonSchema`; a schema with none (or a failed conversion) throws the new `ARKI_HTTP_E013` naming `withJsonSchema`. `$defs` are kept as `components.schemas`.
- Breaking: `storedResponse` (`@arki/http/idempotency`) is typed `StandardSchemaV1<unknown, StoredResponse>`: read it with `parse` from `@arki/schema`.
- New: a cross-field `check` hook on routes and SSE routes; its issues answer 400.
- New: `codec`, `optional`, `Codec`, `Wire`, `Field`, `Fields`, `FieldsOf`, `Optional`, `Reversible`, `ValueOf`, `WireValue`, `CheckResult`, `ErasedInput` exports.
