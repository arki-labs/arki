---
'@arki/resilience': minor
---

`backoff.while` also takes failure definitions from `@arki/failure`: `backoff.exponential({ base: 100 }).while(ExportUnavailable)`. Thrown errors keep retrying, as without `while`. Returned failures of the listed definitions retry too, and other returned failures do not. Pass one or more definitions in one call; a second `while` narrows the first, as before. The predicate form, `.while(reason => …)`, is unchanged. `while()` with nothing throws `InvalidBackoffError`.
