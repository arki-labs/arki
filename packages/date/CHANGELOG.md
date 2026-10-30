# @arki/date

## 0.5.0

### Minor Changes

- ed4abd5: A malformed locale tag (an `Accept-Language` header, a cookie) no longer throws. `format`, `formatIntl`, `formatRange`, `parseDate`, `parseDateTime`, `parseZoned`, `relative`, `humanizeDuration`, `formatDurationIntl`, `weekRulesFor` and the `date` context fall back to `en-US` and log the swap at DEBUG (`arki:date:locale`). New `parseDuration(text)` returns an `InvalidDateText` failure (`operation` `'parseDuration'`, `reason` `'invalid_duration'`) for text that is not an ISO 8601 duration; both names were added to the failure's lists. A hand-built `BusinessCalendar` with all seven weekend days now throws `RangeError` in the business-day walks instead of looping forever. The zod issue messages copy a bounded part of the input. The oRPC and SuperJSON codecs document that their `deserialize` hooks have no failure channel. `@arki/log` is a new dependency.

### Patch Changes

- Updated dependencies [a7a4a9d]
  - @arki/log@0.4.0

## 0.4.0

### Minor Changes

- db67617: Parsers return, builders throw. `parseISO`, `parseDate`, `parseDateTime`, `parseZoned` and `fromPickerDate` return the value or an `@arki/failure` value instead of throwing on bad outside input: `InvalidDateText` (`date.invalid_text`, 400, `data.reason` from `DATE_TEXT_REASONS` and a copy of the text cut to 64 characters), `InvalidNativeDate` (`date.invalid_native_date`, 400) and `UnknownTimeZone` (`date.unknown_time_zone`, 400). Breaking: `tryParse`, `tryParseDate`, `tryParseDateTime`, `tryParseZoned`, `ParseKinds` and `ParseResult` are removed; check results with `isFailure(result)` or `InvalidDateText.is(result)`. Builders (`plainDate`, `plainDateTime`, `instant`, `zoned`, `inZone`) still throw on the caller's own values. `fromUnix` now throws its own `RangeError` past ±8.64e12 seconds instead of a bare `BigInt` error. `@arki/failure` is now a runtime dependency. See `docs/upgrades/0.3.0-to-0.4.0.md`.

## 0.3.0

### Minor Changes

- 13bb516: Rename the `@arki/date/serialize` entry to `@arki/date/orpc`. It holds the oRPC and SuperJSON codecs, which need optional peers, so it now has a name that says it is an adapter. Replace `from '@arki/date/serialize'` with `from '@arki/date/orpc'`. No alias is left behind.

### Patch Changes

- abffdfd: Docs standard: README sections, `AGENTS.md`, `llms.txt`, an agent guide, a tested `examples/delivery-estimate.ts`, and a runtimes table run under Node 26. no demo impact: documentation and doc-example changes only, runtime behaviour unchanged
- d2be96e: Run on React Native's Hermes: `businessCalendar`, interval merging and parsing no longer call `Array.prototype.toSorted`, which Hermes V1 lacks. Each call sorted a fresh array, so behaviour is unchanged.
- 4789c7e: Make `@arki/date` run on Hermes V1 (React Native). Its `Intl.DateTimeFormat#formatToParts` types a lone field (`{ month: 'long' }`) as one `literal` part, so stand-alone month and weekday names (`LLL`, `LLLL`, `EEE`, `EEEE`) now read the formatted text directly. `weekRulesFor` returns its fallback when `Intl.Locale` is missing. Zone names (`z`, `zzzz`), `formatRange` and `relative` need Intl APIs Hermes lacks: they throw a `RangeError` that names the missing API instead of "undefined is not a function".
- Updated dependencies [12e7fa2]
- Updated dependencies [1668156]
- Updated dependencies [abffdfd]
- Updated dependencies [9669a84]
  - @arki/clock@0.1.0

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
