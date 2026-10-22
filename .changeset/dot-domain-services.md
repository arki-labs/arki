---
'@arki/dot': minor
---

New step `.domainServices({ … })` between `.infra()` and `.features()`. A domain service is logic with dependencies that usecases share: a plain factory `(deps: Pick<DomainDeps, …>) => value`, built once per boot, seen by usecases and by children through `domainService(fn)`, never by `provides` or entrypoints. It sees only what is written above it, so a cycle cannot be written. A factory cannot fail. New codes `ARKI_DOT_E034` (a domain service named outside its parent) and `ARKI_DOT_E035` (steps out of order).
