---
'@arki/dot': minor
---

New step `.domainServices({ name: factory })` in a feature chain, between `.infra()` and `.features()`. Use it for logic with dependencies that two or more usecases share, or that a child feature needs. Write a plain factory `(deps: Pick<DomainDeps, …>) => value`. It is built once per boot, usecases read it by key, and a child names it with `domainService(fn)`. A factory cannot return a `Failure`. Two new error codes: `ARKI_DOT_E034` (a child needs a domain service its parent does not declare) and `ARKI_DOT_E035` (`.domainServices()` called twice or out of order).
