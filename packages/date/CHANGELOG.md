# @arki/date

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
