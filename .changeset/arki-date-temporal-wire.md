---
'@arki/date': minor
'@arki/db': minor
---

Temporal values end to end. `@arki/date/serialize` adds `temporalJsonSerializers` (oRPC `customJsonSerializers` for `Instant`, `ZonedDateTime`, `PlainDate`, `PlainDateTime` and `Duration`) and `registerTemporalTypes(superjson)`, so values keep their type across `RPCHandler` → `RPCLink` and SSR dehydration.

`@arki/db/temporal` columns now use Drizzle's exact SQL type names (`timestamp with time zone`, `timestamp`, `date`), so adopting them never produces a migration, and declare Drizzle's `:string` codecs so every driver, Bun SQL included, returns Postgres text. `instant(name, { withTimezone: false })` maps an existing `timestamp` column, read as UTC like Drizzle's own column. Parsing is strict: `infinity` and BC values throw.
