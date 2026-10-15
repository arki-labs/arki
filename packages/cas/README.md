# @arki/cas

A bounded computer algebra package on [`@arki/expr`](../expr) and [`@arki/math`](../math): exact polynomials and rational functions with π and e as symbolic coefficients, closed-form roots, budgets on every input, and results as canonical expr ASTs. The design is specified in `docs/rfcs/2026-10-15-arki-cas.md`. Private, `0.0.x`: build step 1 of the RFC (polynomial core). `simplify`, `derivative`, `derivation` and `factor` come in later steps.

## The ℚ[π, e] assumption

Coefficients live in ℚ[π, e] (ℚ(π, e) for division), with π and e as **independent transcendentals**. A value is treated as zero exactly when all its rational coefficients are zero. That is the standard CAS convention (SymPy's `QQ[pi,E]`, Mathematica's `Together`, Maple's `normal`), and it is **not a theorem**: whether π and e are algebraically independent is an open problem; it is not even known whether π + e is irrational. No relation between them is known. `polynomialIn`, `expand`, `collect`, `rationalize`, `gcd` and `exactRoots` all zero-test under this assumption.

Signs of non-zero constants (a discriminant such as `e^2 + 4*pi`) are decided rigorously: π and e are enclosed in rational intervals from `@arki/math` `PI`/`E`, the value is evaluated in exact interval arithmetic, and the precision doubles up to the `digits` budget. If the sign is still unknown, the answer is "unknown", never a guess (`exactRoots` then returns that part as `numeric`).

## Example

```ts
import { exactRoots, expand, polynomialIn } from '@arki/cas/polynomial';

expand('(x + 1)^3').result.source; // 'x^3 + 3 * x^2 + 3 * x + 1'
expand('0.02*x + 5').result.source; // 'x / 50 + 5'
expand('0.02*x + 5', { numbers: 'decimal' }).result.source; // '0.02 * x + 5'

const form = polynomialIn('x/x + x^2 - x - 2', 'x');
// { kind: 'polynomial', coefficients: [-1, -1, 1] as Exprs, conditions: [x ≠ 0] }
if (form.kind === 'polynomial') exactRoots(form).roots.map(r => r.value.source); // ['(-sqrt(5) + 1) / 2', '(sqrt(5) + 1) / 2']

polynomialIn('pi*x - 1', 'x'); // linear, coefficient `pi`; exactRoots → '1 / pi'
polynomialIn('sin(x) - 1', 'x'); // { kind: 'other', reason: 'transcendental', span: { start: 0, end: 6 } }
```

## Budgets

Every call checks `nodes`, `depth`, `terms`, `degree`, `gcdDegree`, `digits` and `fuel` (defaults 5 000, 256, 10 000, 1 000, 64, 1 000, 100 000) before the expensive work and throws `CasLimitError` (a `ResourceLimitError`) with `budget`, `limit` and `actual`. `signal` is checked every 1 024 fuel units. Input errors are `CasError` (a `MathError`) with a `code` and a one-sentence `remediation`.
