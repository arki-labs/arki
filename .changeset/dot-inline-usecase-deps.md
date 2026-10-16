---
'@arki/dot': minor
---

`.usecases()` infers inline factories: `({ repos }) => () => repos.all()` gets the feature's deps type (needs + infra + children) with no annotation, so a usecase file no longer has to spell `Pick<Deps, 'repos'>`; annotated factories still fit. A factory that asks for a dep the feature lacks still fails with the `DOT: a usecase asks for a dep the feature does not provide` label, naming the usecase and the dep — the inferring signature is the first overload, the labelled one its fallback. New type export: `UsecaseFactoriesOf<D>`.
