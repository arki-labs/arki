---
"@arki/geo": patch
---

`@arki/geo/geocoding` spans each lookup (`geo.geocode`, `geo.reverse_geocode`, `geo.batch_geocode`) and each provider call under it (`geo.<provider>.geocode`, `geo.<provider>.reverse_geocode`), so a fallback shows which provider failed. The lookup span says whether the cache answered (`geo.cache`: `hit`, `miss` or `off`). A failure sets `failure.code`; only a refused or unreachable provider (a fault) sets the error status. Each counts in `geo.operations` (`operation`, `outcome`). The address, coordinates and API keys are never recorded. `@opentelemetry/api` is a new dependency.

Docs: README `## Observability`.
