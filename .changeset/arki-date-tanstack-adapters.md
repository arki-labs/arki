---
'@arki/date': minor
---

`@arki/date/tanstack` adds `temporalSerializationAdapters`: TanStack Router / Start serialization adapters for `Instant`, `ZonedDateTime`, `PlainDate`, `PlainDateTime` and `Duration`. Loader data, server-function results and the SSR payload travel through seroval, which throws on Temporal values; register the adapters once with `createStart(() => ({ serializationAdapters: temporalSerializationAdapters }))`. Values travel as ISO / RFC 9557 text. `@tanstack/react-router` is an optional peer dependency.
