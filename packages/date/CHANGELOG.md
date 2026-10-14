# @arki/date

## 0.2.0

### Minor Changes

- 3c2cc9d: Much faster hot paths. Results are unchanged: every fast path is checked against Temporal on thousands of generated values, and it hands any case it does not cover (other calendars, `reject` on an ambiguous time, rare zone histories) back to Temporal.

  - `parseISO` reads common ISO 8601 text with integer math (about 10× faster).
  - `format` reads fields once with integer math and caches localized names (about 5× faster).
  - `startOf`/`endOf` on plain dates and zoned values, `diff` in days, `isSame*`, `isToday` and friends, and `weekOf` work on day counts instead of Temporal objects.
  - Time-zone offsets come from a per-day cache instead of a new `ZonedDateTime` per question.

- e115648: `@arki/date/tanstack` adds `temporalSerializationAdapters`: TanStack Router / Start serialization adapters for `Instant`, `ZonedDateTime`, `PlainDate`, `PlainDateTime` and `Duration`. Loader data, server-function results and the SSR payload travel through seroval, which throws on Temporal values; register the adapters once with `createStart(() => ({ serializationAdapters: temporalSerializationAdapters }))`. Values travel as ISO / RFC 9557 text. `@tanstack/react-router` is an optional peer dependency.
- 11f2ba7: Temporal values end to end. `@arki/date/serialize` adds `temporalJsonSerializers` (oRPC `customJsonSerializers` for `Instant`, `ZonedDateTime`, `PlainDate`, `PlainDateTime` and `Duration`) and `registerTemporalTypes(superjson)`, so values keep their type across `RPCHandler` → `RPCLink` and SSR dehydration.

  `@arki/db/temporal` columns now use Drizzle's exact SQL type names (`timestamp with time zone`, `timestamp`, `date`), so adopting them never produces a migration, and declare Drizzle's `:string` codecs so every driver, Bun SQL included, returns Postgres text. `instant(name, { withTimezone: false })` maps an existing `timestamp` column, read as UTC like Drizzle's own column. Parsing is strict: `infinity` and BC values throw.

## 0.1.0

### Minor Changes

- d06e5a7: Rebuilt on Temporal semantics. `@arki/date` is now a full date/time math
  library: strict constructors (`plainDate`, `plainDateTime`, `zoned`,
  `instant`), `Date` interop with explicit picker conventions, arithmetic with
  one overflow policy (`add`/`sub`/`set`), boundaries and rounding
  (`startOf`/`endOf`/`nextBoundary`/`floor`/`ceil`/`round`), signed differences
  (`diff`/`until`/`diffElapsed`), comparison predicates, calendar facts (ISO and
  configurable weeks, quarters, age), zone projection vs reinterpretation,
  `Duration` algebra and humanizing, half-open `Interval` algebra with anchored
  iteration, business-day calendars, date-fns-compatible token formatting plus
  `Intl` formatting, `Intl.RelativeTimeFormat` relative text, clock-driven
  "today" predicates via `@arki/clock`, and a fluent `date()` wrapper with
  `createDateContext` for tests. Runs on Node, Bun, Deno, browsers and edge
  runtimes (ECMAScript + `Intl` only). Runtime dependency `date-fns` replaced by
  `temporal-polyfill` (ponyfill, native `Temporal` when the runtime has it).
  The legacy `@arki/date/format` (`format`, `toHumanReadableDate`) and
  `@arki/date/parseISO` subpaths keep their contracts.

  Performance and usability pass after an external review: amounts are passed
  to Temporal as plain objects, day arithmetic runs on epoch-day integers,
  `Intl` formatters and compiled `format` patterns are cached, business-day
  walks jump whole weeks and survive zones that skip a calendar day,
  `nextBoundary` is monotonic across half-hour DST shifts and visits the
  repeated hour of a fold, `zoned(text, zone)` accepts exact or wall-clock
  strings, `formatRange` renders spans, fluent zone changes travel with the
  value, `createDateContext().isToday` matches `clock`'s, and years 0–99
  round-trip through `Date`.

  API cleanup (no backward compatibility before 1.0): every clock reader takes
  one options shape (`now({ clock })`, `nowIn({ timeZone, clock })`,
  `isPast(value, { clock })`); the `@arki/date/parseISO` subpath and
  `toHumanReadableDate` are gone — `parseISO` now lives in core, returns an
  `Instant` and throws on invalid text, and `format(value, 'LLL dd, y')`
  replaces the helper; the fluent `date()` reads zone-less text in its zone.
  New: `parse` module (`parseDate`/`parseDateTime`/`parseZoned` and `try…`
  variants, the inverse of `format`), `@arki/date/zod` schemas,
  `@arki/date/react` hooks (`useNow`, `useToday`, `useRelativeTime`),
  `nthWeekdayOfMonth`/`lastWeekdayOfMonth`, `easter` (western and orthodox),
  `weekRulesFor(locale)`, `formatDurationIntl`, and type tests pinning
  `UnitFor`/`AmountFor`/`BucketUnitFor`.

## 0.0.3

### Patch Changes

- Dependency refresh: `date-fns` 4.4.0. No API changes.

## 0.0.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.

## 0.0.1

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  Part of **Wave 1**, the ARKI foundation: zero-dependency utilities and runtime primitives shipped together because every downstream wave (DOT kernel, infrastructure adapters) consumes them. Wave 1 packages: `assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`.

  **Why 0.0.x, not 1.0.0**: ARKI is on an experimental track. The 0.0.x prefix is an honest signal — APIs may change without semver discipline until the kernel is field-tested. The release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) is satisfied at this version; the gate certifies _the artifact_, not _API stability_. Stability is earned through reuse, not declared at first publication.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
