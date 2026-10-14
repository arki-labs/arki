---
'@arki/date': patch
---

Make `@arki/date` run on Hermes V1 (React Native). Its `Intl.DateTimeFormat#formatToParts` types a lone field (`{ month: 'long' }`) as one `literal` part, so stand-alone month and weekday names (`LLL`, `LLLL`, `EEE`, `EEEE`) now read the formatted text directly. `weekRulesFor` returns its fallback when `Intl.Locale` is missing. Zone names (`z`, `zzzz`), `formatRange` and `relative` need Intl APIs Hermes lacks: they throw a `RangeError` that names the missing API instead of "undefined is not a function".
