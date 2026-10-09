---
'@arki/date': minor
---

Rebuilt on Temporal semantics. `@arki/date` is now a full date/time math
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
