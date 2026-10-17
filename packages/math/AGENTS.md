AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/math: Laws

A zero-dependency math toolkit: exact types where it must be, fast float where it can be. Read these before you change or use it.

## Laws

1. Two layers, never mixed silently. `Decimal` and `Rational` are exact. Plain-number helpers are float64. A result says which one it is.
2. Nothing returns `NaN` or `null` to signal failure. Every deliberate failure is a typed error under `MathError` with a stable `ARKI_MATH_E<nnn>` code and a `remediation`. Match on the code.
3. No default rounding for exact types. A result that needs rounding throws `RoundingNecessaryError` until the caller passes a scale and a mode.
4. A `Decimal` never becomes a float by accident. `d + 1` and `+d` throw. Only `toNumber()` converts, on purpose.
5. Every `Decimal` and `Rational`, input or result, has at most 10 000 digits and an exponent of at most 10 000. Larger input throws `ResourceLimitError`. These are guards against hostile input, not precision settings.
6. Numeric methods report an error estimate. A method that misses its tolerance throws a `ConvergenceError` subclass holding its best estimate in `.best`. It never returns a wrong number.
7. Every accuracy claim is checked against independent reference data (mpmath, NIST StRD). Never state a bound that a test does not check.
8. Zero runtime dependencies. No `node:*` or `bun:*` import, no `process`, no `Buffer` in library code. The lint config rejects them.
9. Subpath imports are the public surface. `linear-algebra` stays out of the root because its short names would clash.
10. Money lives in `@arki/money`, symbolic algebra in `@arki/cas`, expression parsing in `@arki/expr`. Do not add them here.
11. Never game a benchmark. Never write benchmark numbers by hand; the README block comes from an idle run.
12. Types are written once and inferred everywhere. No `any`, no `@ts-ignore`, no unsafe casts.

## Changing this package

- A new module needs an `exports` entry, a top `/** ... */` summary in its entry file, a page in `docs/modules/`, a row in the README tables and a test.
- A new error code needs a `MATH_ERROR_CODES` entry with `@fix` and `@verify` tags and a test in `errors.test.ts`.
- A new accuracy claim goes into `docs/accuracy.md` with its reference data and test.
- Breaking changes are allowed below 1.0. A breaking change is a MINOR changeset.
- Run `bun run test:runtimes` on Node 26 to refresh the runtimes table. Never run a benchmark publish profile.
- Doc examples live in `README.md` and `docs/`. Run them with `bun run test:docs`.

## Verify

```sh
bun run test:docs
bun run typecheck
bun run test
bun run lint
bun ../../tooling/library/src/llms.ts --check
```
