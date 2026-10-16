---
'@arki/dot': patch
---

`.usecases()` no longer rejects an inline factory whose returned function has an untyped or defaulted parameter, such as `({ repos }: Pick<Deps, 'repos'>) => (fail = false) => …`. Such a factory is context-sensitive, so TypeScript checks the call twice; in the first pass `F` is still its constraint and the guard wrongly flagged every key as "a usecase asks for a dep the feature does not provide". A factory that asks for `never` now counts as asking for nothing. A factory that really asks for a dep the feature lacks is still a compile error, inline or not.
