AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/cas: Laws

A bounded computer algebra package on `@arki/expr` and `@arki/math`. Read these before you change or use it.

## Laws

1. Results are exact. Arithmetic is over ℚ, with π and e as symbols. Floats appear only in the `numeric` parts of `exactRoots`, and those say `exact: false`.
2. π and e are treated as independent transcendentals. A value is zero only when all its rational coefficients are zero. This is a convention, not a theorem. Never present it as a proof.
3. A sign that cannot be decided is "unknown", never a guess. The sign oracle doubles its precision up to the `digits` budget, then gives up.
4. Version 0.x is real-only. Every variable ranges over the reals and every function is its real version.
5. A rewrite that widens the domain returns the lost restriction in `conditions`. A rewrite that needs a caller assumption returns it with reason `assumed`. Never drop a condition.
6. Every verb is bounded. Budgets are checked before the costly work, and fuel is spent by bigint size. Hostile input throws `CasLimitError` within 100 ms (1 s for `factor`).
7. Input problems throw `CasError` with a `code`, a one-sentence `remediation` and a `span`. Values never cause `CasError`; budgets throw `CasLimitError`.
8. `derivation` returns the same result as `derivative`. It carries i18n template keys and params, never English.
9. A verb does not import another verb's code through the root entry. Verbs live in their own subpath so a bundle pays only for what it imports.
10. Types are written once and inferred everywhere. No `any`, no `@ts-ignore`, no unsafe casts.

## Changing this package

- A new rewrite rule goes into the rule table in `normal.ts` with a property test at random rational points and a test for each condition it returns.
- A new `CasErrorCode` needs a `REMEDIATION` entry and a test that triggers it.
- A change to a default budget changes the `Limits` section of `README.md` in the same commit.
- A new `factor` fixture comes from SymPy (`test/reference/gen_factor.py`), not from this package.
- Doc examples live in `README.md` and `docs/`. Run them with `bun run test:docs`.

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
