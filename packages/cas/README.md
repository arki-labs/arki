# @arki/cas

A bounded computer algebra package on [`@arki/expr`](../expr) and [`@arki/math`](../math): exact polynomials and rational functions with π and e as symbolic coefficients, closed-form roots, budgets on every input, and results as canonical expr ASTs. The design is specified in `docs/rfcs/2026-10-15-arki-cas.md`. Version `0.0.x`; build steps 1 to 4 of the RFC (polynomial core; conditions, the sign oracle and `simplify`; `derivative` and the rule-by-rule `derivation`; `factor` over ℚ).

## Install

```sh
bun add @arki/cas @arki/expr @arki/math
```

## Quick start

Simplify a formula, differentiate it, and read the conditions that the result needs.

```ts run
import { derivative } from '@arki/cas/derivative';
import { simplify } from '@arki/cas/simplify';

const simplified = simplify('x/x');
if (simplified.result.source !== '1') throw new Error('x/x did not simplify to 1');
if (simplified.conditions.length !== 1) throw new Error('the lost restriction x != 0 must come back as a condition');

const slope = derivative('x^3', 'x');
if (slope.result.source !== '3 * x^2') throw new Error(`unexpected derivative: ${slope.result.source}`);
```

### Polynomials

```ts
import { exactRoots, expand, polynomialIn } from '@arki/cas/polynomial';

expand('(x + 1)^3').result.source; // 'x^3 + 3 * x^2 + 3 * x + 1'
expand('0.02*x + 5').result.source; // 'x / 50 + 5'
expand('0.02*x + 5', { numbers: 'decimal' }).result.source; // '0.02 * x + 5'

const form = polynomialIn('x/x + x^2 - x - 2', 'x');
// { kind: 'polynomial', coefficients: [-1, -1, 1] as Exprs, conditions: [x ≠ 0] }
if (form.kind === 'polynomial') exactRoots(form).roots.map(r => r.value.source); // ['(-sqrt(5) + 1) / 2', '(sqrt(5) + 1) / 2']

polynomialIn('pi*x - 1', 'x'); // linear, coefficient `pi`; exactRoots → '1 / pi'
polynomialIn('x^4 - 5*x^2 + 4', 'x'); // exactRoots → ['-2', '-1', '1', '2'], by factoring over ℚ
polynomialIn('sin(x) - 1', 'x'); // { kind: 'other', reason: 'transcendental', span: { start: 0, end: 6 } }
```

## When not to use this

- You need full symbolic integration, limits, series or equation systems. Version 0.0.x has none of them.
- You need complex-valued algebra. Every variable ranges over the reals.
- You need factoring of multivariate polynomials. Only univariate polynomials over ℚ factor completely.
- You only evaluate numbers. Use `@arki/expr` with `@arki/math`.
- You must prove that two expressions with both π and e are equal. The zero test relies on an unproven assumption (see below).

## Runtime support

Pure TypeScript on `@arki/expr` and `@arki/math`, with no Node built-ins. It runs where those two run: Node, Bun, Deno and browsers.

## Public imports

| Import                 | What it gives you                                                                 |
| ---------------------- | --------------------------------------------------------------------------------- |
| `@arki/cas`            | Shared types, `CasError`, `CasLimitError`, `conditionToLatex`                     |
| `@arki/cas/polynomial` | `expand`, `collect`, `rationalize`, `polynomialIn`, `gcd`, `exactRoots`, `factor` |
| `@arki/cas/simplify`   | `simplify`                                                                        |
| `@arki/cas/derivative` | `derivative`                                                                      |
| `@arki/cas/derivation` | `derivation`: the result plus the rule-by-rule steps                              |

## Failure behaviour

Every verb returns a result or throws. A result never holds `NaN`.

- **Input outside what the verb handles:** `CasError` with a `code` (`unsupported-function`, `not-differentiable`, `not-in-domain`, `bad-variable`, `not-rational`, `not-polynomial`, `unsupported-constant`), a one-sentence `remediation` and a `span` into the input. Show the span and the remediation.
- **Over a budget:** `CasLimitError` with `budget`, `limit` and `actual`. Reject the input or raise the budget on purpose.
- **A rewrite that widened the domain:** not a failure. The result lists `conditions`. Show them next to the answer.
- **A sign that cannot be decided:** `exactRoots` returns that part as `numeric` with `exact: false`. It never guesses.
- **Parse errors:** text that is not an expression throws `ParseError` from `@arki/expr`.

## Limits

Every call checks `nodes`, `depth`, `terms`, `degree`, `gcdDegree`, `digits` and `fuel` (defaults 5 000, 256, 10 000, 1 000, 64, 1 000, 100 000) before the expensive work; `derivative` and `derivation` also check `order` (10) before starting, and a derivation checks `steps` (2 000; two per distinct subterm plus 16, before each order) and `stepNodes` (50 000 printed nodes, before printing the steps). `factor` checks `factorDegree` (128) and `factorDigits` (300 digits in a coefficient) on each square-free part, `liftDigits` (2 000 digits in the Hensel modulus) before lifting and `recombination` (65 536 candidate products) while recombining; bigint arithmetic spends fuel by size, so hostile inputs throw within a second. A derivation spends more fuel than `derivative`: it simplifies once more per rule it shows. The readable normal form puts a sum of unrelated fractions over one denominator, so a high order of such a sum can reach the `terms` or `fuel` budget; rewriting has no static bound, so each `simplify` rewrite also costs fuel and throws `CasLimitError` (a `ResourceLimitError`) with `budget`, `limit` and `actual`. `signal` is checked every 1 024 fuel units. Input errors are `CasError` (a `MathError`) with a `code` and a one-sentence `remediation`.

Boundary example: the default `degree` budget is 1 000. `expand('x^500')` works. `expand('x^1001')` throws `CasLimitError` with `budget: 'degree'`, `limit: 1000` and `actual: 1001`, before any work.

```ts run
import { CasLimitError } from '@arki/cas';
import { expand } from '@arki/cas/polynomial';

expand('x^500');
let caught: CasLimitError | undefined;
try {
  expand('x^1001');
} catch (error) {
  if (error instanceof CasLimitError) caught = error;
}
if (caught?.budget !== 'degree' || caught.limit !== 1000) throw new Error('the degree budget did not trip at 1001');
```

## Documentation

- [Agent guide](docs/agent-guide.md): the model, the task map and the rules.
- [llms.txt](llms.txt): the short index for agents.
- [CHANGELOG](CHANGELOG.md): what changed in each version.
- Design: `docs/rfcs/2026-10-15-arki-cas.md` in the Arki workspace.

## Support

Report a bug or ask a question in the [Arki issue tracker](https://github.com/arki-labs/arki/issues). Include the input, the verb and the error `code`.

## The ℚ[π, e] assumption

Coefficients live in ℚ[π, e] (ℚ(π, e) for division), with π and e as **independent transcendentals**. A value is treated as zero exactly when all its rational coefficients are zero. That is the standard CAS convention (SymPy's `QQ[pi,E]`, Mathematica's `Together`, Maple's `normal`), and it is **not a theorem**: whether π and e are algebraically independent is an open problem; it is not even known whether π + e is irrational. No relation between them is known. `polynomialIn`, `expand`, `collect`, `rationalize`, `gcd`, `exactRoots` and `simplify` all zero-test under this assumption.

Signs of non-zero constants (a discriminant such as `e^2 + 4*pi`) are decided rigorously: π and e are enclosed in rational intervals from `@arki/math` `PI`/`E`, the value is evaluated in exact interval arithmetic, and the precision doubles up to the `digits` budget. If the sign is still unknown, the answer is "unknown", never a guess (`exactRoots` then returns that part as `numeric`).

## Guarantees

Results are exact: arithmetic is over ℚ, with π and e as symbols under the assumption above. Floats appear only in the `numeric` parts of `exactRoots`, which say `exact: false`. Every call returns or throws a typed error within its budgets. The evidence is in `src/*.test.ts`; property tests use fast-check, and the factor fixtures come from SymPy (`test/reference/gen_factor.py`, dev-only).

| Verb                                               | Guarantee                                                                                                                                                                      | Evidence                                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expand`, `collect`, `rationalize`, `polynomialIn` | The same value as the input wherever the input is defined; conditions name every restriction the result lost.                                                                  | Ring laws, 200 runs each; exact values at random rational points with π and e replaced by rationals, 300 runs; AST → polynomial → AST round trip, 200 runs; the equation solver corpus                                |
| `gcd`                                              | Divides both inputs, and every common divisor divides it. Monic for one generator; otherwise coprime integer coefficients with the term that prints first positive (`x - pi`). | gcd(A·C, B·C) is divisible by C, divides both and leaves coprime cofactors, 200 runs                                                                                                                                  |
| `simplify`                                         | The same exact value wherever the input is defined; every condition is necessary; idempotent.                                                                                  | Exact values at random rational points, 400 runs per rule family; kernel rules in floats within 1e-9, 400 runs; a test per condition that breaking it makes the input undefined; idempotence and round trip, 300 runs |
| `derivative`                                       | The derivative of the input; exact coefficients for polynomials.                                                                                                               | Agreement with `@arki/math/differentiate` at random points within its error estimate, 300 runs; exactly k·cₖ for polynomials, 150 runs; order 2 equals order 1 twice, 100 runs; the derivative calculator corpus      |
| `derivation`                                       | The same result as `derivative`; every step is right on its own.                                                                                                               | Each derivative step checked against the numeric derivative of its `before`, 200 runs; every key in `TEMPLATE_KEYS`                                                                                                   |
| `factor`                                           | `content · ∏ factor^multiplicity` equals the input exactly. With `complete: true`, every factor is irreducible over ℚ.                                                         | 45 SymPy fixtures, factor for factor; factors of A·B are those of A and of B, and the product rebuilds the input, 200 runs                                                                                            |
| `exactRoots`                                       | Every exact root substitutes to exactly 0. A real or complex verdict is never a guess.                                                                                         | Random rational quadratics, 150 runs; over ℚ(π, e) with π and e replaced by rationals and the sign of Δ checked at 200 digits, 120 runs                                                                               |
| every verb                                         | Hostile input throws `CasLimitError` before the work or by fuel: within 100 ms, 1 s for `factor`.                                                                              | `hostile.test.ts`; a degree-128 polynomial with 300-digit coefficients in `factor.test.ts`                                                                                                                            |

## `simplify`

```ts
import { simplify } from '@arki/cas/simplify';

simplify('x/x'); // '1', conditions: [x ≠ 0]
simplify('sqrt(x^2)'); // 'abs(x)', no conditions: over ℝ this holds everywhere
simplify('sqrt(x^2)', { assume: { x: 'nonnegative' } }); // 'x', conditions: [x ≥ 0 (assumed)]
simplify('sqrt(x^2)', { assume: { x: 'negative' } }); // '-x', conditions: [x < 0 (assumed)]
simplify('exp(ln(x))'); // 'x', conditions: [x > 0]
simplify('ln(exp(x))'); // 'x', no conditions
simplify('exp(x)*cos(x) - exp(x)*sin(x)'); // 'exp(x) * (cos(x) - sin(x))'
simplify('((2*x)*(x - 1) - (x^2 + 1))/(x - 1)^2'); // '(x^2 - 2 * x - 1) / (x - 1)^2'
```

v1 is **real-only**: every variable ranges over ℝ and every function is its real version. The result keeps the input's value wherever the input is defined and the caller's assumptions hold. A rewrite may widen the domain (`x/x → 1`); every restriction it removes comes back in `conditions` (reason `domain`), and so does every caller assumption a rewrite relied on (reason `assumed`). A rewrite that would change the value somewhere the input is defined runs only when the sign oracle proves it safe. A restriction the result still shows is not repeated, and one the oracle proves from the expression and the caller's assumptions (`x^2 + 1 ≠ 0`; `x ≥ 0` when `x` is assumed positive) is not a condition: it holds wherever the result is claimed. Conditions from different sources are merged: `x ≥ 0` and `x ≠ 0` become `x > 0`, and `x > 0` makes `x ≠ 0` redundant. `expand`, `collect`, `rationalize`, `polynomialIn` and `gcd` return lost restrictions the same way (`0*ln(x)` carries `x > 0`).

| Rule                | Rewrite                                                                                       | Needs                                       | Returns                                 |
| ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| `fold`              | literal arithmetic, `0*u`, `u + 0`, `1*u`, `u^1`, `u/1`                                       | —                                           | restrictions of a dropped `u`           |
| `expand`, `collect` | products and powers of sums multiplied out; like terms and powers                             | —                                           | —                                       |
| `cancel`            | gcd cancellation                                                                              | —                                           | cancelled factor ≠ 0                    |
| `integer-powers`    | `(u^(p/q))^k → u^(kp/q)` for an integer kp/q                                                  | —                                           | `u ≥ 0` (or `> 0`) of the removed power |
| `fractional-powers` | `(u^a)^b`, `(g^m)^q`, `u^a·u^b` with non-integer exponents                                    | `u > 0` proven or assumed                   | the assumption                          |
| `sqrt-of-square`    | `sqrt(c·u^2) → sqrt(c)·abs(u)`, then `→ u`                                                    | `u ≥ 0` proven or assumed for `→ u`         | the assumption                          |
| `square-of-sqrt`    | `sqrt(u)^2 → u`, likewise `cbrt` and `nthRoot`; `u/sqrt(u) → sqrt(u)`                         | —                                           | `u ≥ 0` (even roots)                    |
| `exp-ln`            | `exp(ln(u)) → u`                                                                              | —                                           | `u > 0`                                 |
| `ln-exp`            | `ln(exp(u)) → u`, `ln(e^k) → k`                                                               | real (v1 always)                            | —                                       |
| `exp-product`       | `exp(a)·exp(b) → exp(a + b)`, `exp(a)^y → exp(y·a)`, `1/exp(a) → exp(-a)`                     | —                                           | —                                       |
| `abs-sign`          | `abs(u) → ±u`; `abs(u)/u → sign(u)`                                                           | sign of `u` proven or assumed for the first | the assumption; `u ≠ 0`                 |
| `parity`            | `f(-u) → -f(u)` for odd, `f(u)` for even functions (`sin`, `cos`, `abs`, …)                   | —                                           | —                                       |
| `special-values`    | `sin(0)`, `cos(0)`, `tan(0)`, `exp(0)`, `ln(1)`, `ln(e)`, exact `sqrt` and `abs` of rationals | —                                           | —                                       |
| `factor-out`        | a common kernel factor pulled out of a sum (printing only)                                    | —                                           | —                                       |

Anything not in the table is left alone (`sin(x)^2 + cos(x)^2` stays). `applied` lists the rules that changed something; the printed normal form itself is not a rule (`x^-1` prints as `1 / x`, `e^x` as `exp(x)`, terms in canonical order). `u^(k/2)` is read as `sqrt(u)^k`, so `x^(1/2)` and `sqrt(x)` are one value: `x^(1/2) - sqrt(x)` is `0`, and `x^(3/2)` prints as `x * sqrt(x)`.

**The sign oracle** decides "proven". It is small, sound and incomplete; "unknown" never licenses a rewrite. It knows: assumed signs of names (`nonzero`, `positive`, `nonnegative`, `negative`, per call); signs of ℚ[π, e] constants (rigorous, as above); `exp(u)`, `cosh(u)` > 0; `abs(u)`, `sqrt(u)`, even roots and `u^(p/q)` ≥ 0; even powers and expanded perfect squares ≥ 0; `ln(u)`, `log10(u)` and `log2(u)` have the sign of `u − 1`; odd increasing functions (`sign`, `atan`, `sinh`, …) keep the sign of their argument; sums of non-negatives with one positive term are positive; products and quotients by sign rules.

**The readable normal form.** One fraction; the numerator expanded, with a common kernel factor pulled out; the denominator printed as a product of the factors the input divided by, split further by content and repeated factors (`(x - 1)^2`). Names are ordered by name, so the output does not depend on how the input was written and `simplify` is idempotent. `numbers: 'decimal'` prints terminating rationals as decimals.

## `derivative` and `derivation`

```ts
import { derivative } from '@arki/cas/derivative';

derivative('x^3 - 2*x^2 + x', 'x').result.source; // '3 * x^2 - 4 * x + 1'
derivative('sin(x^2)', 'x').result.source; // '2 * x * cos(x^2)'
derivative('x^2 * y', 'y').result.source; // 'x^2': other names are constants
derivative('x^5', 'x', { order: 5 }).result.source; // '120'
derivative('ln(x)', 'x'); // '1 / x', conditions: [x > 0]: ln is only defined there
derivative('abs(x)', 'x'); // 'sign(x)', conditions: [x ≠ 0 (differentiable)]
derivative('sin(x^2)', 'x', { simplify: false }).result.source; // 'cos(x^2) * (2 * x)'
derivative('floor(x)', 'x'); // throws CasError 'not-differentiable', span of floor(x)
```

Rules: constant, variable, sum, constant multiple, product, quotient, power, exponential (`a^u`, `e^u`, `exp`), general power `f^g`, logarithms (`ln`, `log`, `log(u, b)`, `log10`, `log2`), every trig, inverse trig, hyperbolic and inverse hyperbolic function of expr's `scientific` language, roots (`sqrt`, `cbrt`, `nthRoot`), `abs`, and the chain rule. `floor ceil round fix sign mod` of the variable throw `not-differentiable` (their derivative is 0 almost everywhere, and 0 would hide the jumps); `factorial`, `gamma` and host functions throw `unsupported-function`. Of a constant, any function is 0. Each distinct subterm is derived once (hash-consing), so the cost is linear in the expression's DAG; each order is normalized by the `simplify` rule table before the next.

`@arki/cas/derivation` returns the same result plus the full derivation tree. `derivative`'s bundle contains none of the step code (checked on the built package by `scripts/entries.mjs`).

```ts
import { derivation, ruleFormula, TEMPLATE_KEYS } from '@arki/cas/derivation';

const { steps } = derivation('sin(x^2)', 'x');
// #0 derivation                    sin(x^2) → 2 * x * cos(x^2)
//   #1 order 1                     sin(x^2) → 2 * x * cos(x^2)
//     #2 chain                     sin(x^2) → cos(x^2) * (2 * x)
//       #3 function sin            sin(x^2) → cos(x^2)
//       #4 power                   x^2 → 2 * x
//     #5 simplification            cos(x^2) * (2 * x) → 2 * x * cos(x^2)
//       #6 normal form             cos(x^2) * (2 * x) → 2 * x * cos(x^2)
ruleFormula({ kind: 'derivative', id: 'product' }); // "(f g)' = f' g + f g'"
```

Every step has a pre-order `index`, a `rule`, a `template` (`key` plus `params`), `before`, `after`, `children` and the `conditions` it introduced. A derivative step's `after` is the derivative of its `before` with `fold` applied only; the chain rule is its own step, with the outer rule (`f'(u)`) and `u'` as children. A subterm derived before is a `repeat` step pointing at the first one. Each order's `simplification` shows the algebraic normal form as one step (`fold`, `expand`, `collect` and `cancel` are computed together, so `phases` lists which happened), then each rule of the table that changed the expression, in table order, then `factor-out`.

No English is built in: `template.key` is the translation key, and `TEMPLATE_KEYS` lists every key, so an app test can check its translations. English reference texts for all 58 keys, to copy into a locale file:

| Key                            | English                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `derivation`                   | Differentiate with respect to {x} ({order} times).                             |
| `derivation.order`             | Derivative number {order}.                                                     |
| `derivation.simplification`    | Simplify the result.                                                           |
| `derivative.constant`          | {c} is a constant: its derivative is 0.                                        |
| `derivative.variable`          | The derivative of {x} is 1.                                                    |
| `derivative.sum`               | Differentiate each term separately.                                            |
| `derivative.constant-multiple` | Keep the constant factor {c} and differentiate {f}.                            |
| `derivative.constant-divisor`  | Divide the derivative of {f} by the constant {c}.                              |
| `derivative.product`           | Product rule for {f} times {g}.                                                |
| `derivative.quotient`          | Quotient rule for {f} over {g}.                                                |
| `derivative.power`             | Power rule with exponent {n}.                                                  |
| `derivative.exponential`       | Exponential rule with base {a}.                                                |
| `derivative.exponential.e`     | The exponential function is its own derivative.                                |
| `derivative.general-power`     | Write the power as an exponential of a logarithm and differentiate.            |
| `derivative.logarithm`         | The derivative of the natural logarithm is one over its argument.              |
| `derivative.logarithm.base`    | Logarithm to base {b}: divide by ln({b}).                                      |
| `derivative.root.sqrt`         | Write the square root as a power and use the power rule.                       |
| `derivative.root.cbrt`         | Write the cube root as a power and use the power rule.                         |
| `derivative.root.nth`          | Write the root of degree {n} as a power and use the power rule.                |
| `derivative.absolute-value`    | The derivative of the absolute value is the sign, where the argument is not 0. |
| `derivative.chain`             | Chain rule: the outer derivative times the derivative of {u}.                  |
| `derivative.repeat`            | Already differentiated in step {of}.                                           |
| `derivative.function.sin`      | The derivative of sin(u) is cos(u).                                            |
| `derivative.function.cos`      | The derivative of cos(u) is -sin(u).                                           |
| `derivative.function.tan`      | The derivative of tan(u) is sec(u)^2.                                          |
| `derivative.function.sec`      | The derivative of sec(u) is sec(u) * tan(u).                                   |
| `derivative.function.csc`      | The derivative of csc(u) is -csc(u) * cot(u).                                  |
| `derivative.function.cot`      | The derivative of cot(u) is -csc(u)^2.                                         |
| `derivative.function.asin`     | The derivative of arcsin(u) is 1 / sqrt(1 - u^2).                              |
| `derivative.function.acos`     | The derivative of arccos(u) is -1 / sqrt(1 - u^2).                             |
| `derivative.function.atan`     | The derivative of arctan(u) is 1 / (1 + u^2).                                  |
| `derivative.function.asec`     | The derivative of arcsec(u) is 1 / (\|u\| * sqrt(u^2 - 1)).                    |
| `derivative.function.acsc`     | The derivative of arccsc(u) is -1 / (\|u\| * sqrt(u^2 - 1)).                   |
| `derivative.function.acot`     | The derivative of arccot(u) is -1 / (1 + u^2).                                 |
| `derivative.function.sinh`     | The derivative of sinh(u) is cosh(u).                                          |
| `derivative.function.cosh`     | The derivative of cosh(u) is sinh(u).                                          |
| `derivative.function.tanh`     | The derivative of tanh(u) is sech(u)^2.                                        |
| `derivative.function.sech`     | The derivative of sech(u) is -sech(u) * tanh(u).                               |
| `derivative.function.csch`     | The derivative of csch(u) is -csch(u) * coth(u).                               |
| `derivative.function.coth`     | The derivative of coth(u) is -csch(u)^2.                                       |
| `derivative.function.asinh`    | The derivative of arsinh(u) is 1 / sqrt(u^2 + 1).                              |
| `derivative.function.acosh`    | The derivative of arcosh(u) is 1 / sqrt(u^2 - 1).                              |
| `derivative.function.atanh`    | The derivative of artanh(u) is 1 / (1 - u^2).                                  |
| `derivative.function.asech`    | The derivative of arsech(u) is -1 / (u * sqrt(1 - u^2)).                       |
| `derivative.function.acsch`    | The derivative of arcsch(u) is -1 / (\|u\| * sqrt(1 + u^2)).                   |
| `derivative.function.acoth`    | The derivative of arcoth(u) is 1 / (1 - u^2).                                  |
| `simplify.normal-form`         | Expand, collect like terms and cancel common factors.                          |
| `simplify.integer-powers`      | Combine nested powers with whole-number exponents.                             |
| `simplify.fractional-powers`   | Combine powers of the same base by adding the exponents.                       |
| `simplify.sqrt-of-square`      | The square root of a square is the absolute value.                             |
| `simplify.square-of-sqrt`      | The square of a square root is the radicand itself.                            |
| `simplify.exp-ln`              | e raised to ln(u) is u.                                                        |
| `simplify.ln-exp`              | The natural logarithm of e raised to u is u.                                   |
| `simplify.exp-product`         | Combine products of exponentials by adding the exponents.                      |
| `simplify.abs-sign`            | The absolute value divided by its argument is the sign.                        |
| `simplify.parity`              | Use the symmetry of the function to remove the minus sign inside.              |
| `simplify.special-values`      | Replace known special values such as sin(0) and ln(1).                         |
| `simplify.factor-out`          | Factor out the common factor.                                                  |

## `factor`

```ts
import { factor } from '@arki/cas/polynomial';

factor('x^2/2 - 1/8', 'x'); // content 1/8, factors 2 * x + 1 and 2 * x - 1, complete: true
factor('x^60 - 1', 'x').factors.length; // 12 cyclotomic factors
factor('y*x^2 - y', 'x'); // content y, factors x + 1 and x - 1, complete: true
factor('x^2 - y', 'x'); // content 1, factor x^2 - y, complete: false
```

`factor(input, variable)` returns `content` (an `Expr` free of the variable), `factors` (each `{ factor, multiplicity }`: primitive, positive leading coefficient, sorted by degree then text), `complete` and `conditions` (lost restrictions of the input, as in every verb). `content · ∏ factor^multiplicity` equals the input.

Univariate polynomials with rational coefficients are factored completely into irreducibles over ℚ by Zassenhaus's algorithm: content and Yun's square-free split, the best of 5 small primes, distinct-degree and Cantor–Zassenhaus splitting mod p (fixed seed, so a run is reproducible), quadratic Hensel lifting over a factor tree to the Landau–Mignotte bound, then recombination of subsets. Other names, π and e may sit in the content. Constants cas cannot zero-test (`sqrt(2)`, `ln(2)`, `exp(1/2)`) throw `CasError` `unsupported-constant` with their span, from `factor` and `gcd` alike: as a free symbol, `sqrt(2)^2 - 2` would not be 0 and `gcd(x - sqrt(2), x^2 - 2)` would be 1, as `polynomialIn` already reports. `expand`, `collect` and `rationalize` keep accepting them: their results are identities for any value. A square-free part whose coefficients involve them is returned whole and sets `complete: false`, unless it has degree 1 in the variable (then it is irreducible: `x^2 + 2xy + y^2` is `(x + y)^2`, complete); multivariate factoring is out of v1. The results match SymPy on 45 reference cases (cyclotomics, Swinnerton-Dyer, Mignotte, random products up to degree 40 with 30-digit coefficients).

`exactRoots` uses the same factoring for rational polynomials of degree 3 and up: every linear and quadratic factor gives exact roots, other factors are `numeric`. When a factoring budget is reached it falls back to the square-free split instead of throwing.

**Size budgets re-baselined 2026-10-30** (founder decision). `.size-limit.json` limits are the measured gzip size rounded up to the next 100 B, plus 5%, rounded up to the next 50 B (entries that already passed were left alone). Why: typed parse failures from @arki/failure add the defineFailure core to entries that parse, and @arki/cas bundles @arki/expr. Commits: 5d5b7b14a1, 420db90f62, 8323e0c892, 0b70840f74.
