# @arki/cas

A bounded computer algebra package on [`@arki/expr`](../expr) and [`@arki/math`](../math): exact polynomials and rational functions with π and e as symbolic coefficients, closed-form roots, budgets on every input, and results as canonical expr ASTs. The design is specified in `docs/rfcs/2026-10-15-arki-cas.md`. Private, `0.0.x`: build steps 1 to 3 of the RFC (polynomial core; conditions, the sign oracle and `simplify`; `derivative` and the rule-by-rule `derivation`). `factor` comes in step 4.

## The ℚ[π, e] assumption

Coefficients live in ℚ[π, e] (ℚ(π, e) for division), with π and e as **independent transcendentals**. A value is treated as zero exactly when all its rational coefficients are zero. That is the standard CAS convention (SymPy's `QQ[pi,E]`, Mathematica's `Together`, Maple's `normal`), and it is **not a theorem**: whether π and e are algebraically independent is an open problem; it is not even known whether π + e is irrational. No relation between them is known. `polynomialIn`, `expand`, `collect`, `rationalize`, `gcd`, `exactRoots` and `simplify` all zero-test under this assumption.

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

## `simplify`

```ts
import { simplify } from '@arki/cas/simplify';

simplify('x/x'); // '1', conditions: [x ≠ 0]
simplify('sqrt(x^2)'); // 'abs(x)', no conditions: over ℝ this holds everywhere
simplify('sqrt(x^2)', { assume: { x: 'nonnegative' } }); // 'x', conditions: [x ≥ 0 (assumed)]
simplify('exp(ln(x))'); // 'x', conditions: [x > 0]
simplify('ln(exp(x))'); // 'x', no conditions
simplify('exp(x)*cos(x) - exp(x)*sin(x)'); // 'exp(x) * (cos(x) - sin(x))'
simplify('((2*x)*(x - 1) - (x^2 + 1))/(x - 1)^2'); // '(x^2 - 2 * x - 1) / (x - 1)^2'
```

v1 is **real-only**: every variable ranges over ℝ and every function is its real version. The result keeps the input's value wherever the input is defined and the caller's assumptions hold. A rewrite may widen the domain (`x/x → 1`); every restriction it removes comes back in `conditions` (reason `domain`), and so does every caller assumption a rewrite relied on (reason `assumed`). A rewrite that would change the value somewhere the input is defined runs only when the sign oracle proves it safe. A restriction the result still shows is not repeated, and one the oracle proves from the expression itself (`x^2 + 1 ≠ 0`) is not a condition. `expand`, `collect`, `rationalize`, `polynomialIn` and `gcd` return lost restrictions the same way (`0*ln(x)` carries `x > 0`).

| Rule                | Rewrite                                                                                       | Needs                                       | Returns                                 |
| ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| `fold`              | literal arithmetic, `0*u`, `u + 0`, `1*u`, `u^1`, `u/1`                                       | —                                           | restrictions of a dropped `u`           |
| `expand`, `collect` | products and powers of sums multiplied out; like terms and powers                             | —                                           | —                                       |
| `cancel`            | gcd cancellation                                                                              | —                                           | cancelled factor ≠ 0                    |
| `integer-powers`    | `(u^(p/q))^k → u^(kp/q)` for an integer kp/q                                                  | —                                           | `u ≥ 0` (or `> 0`) of the removed power |
| `fractional-powers` | `(u^a)^b`, `(g^m)^q`, `u^a·u^b` with non-integer exponents                                    | `u > 0` proven or assumed                   | the assumption                          |
| `sqrt-of-square`    | `sqrt(c·u^2) → sqrt(c)·abs(u)`, then `→ u`                                                    | `u ≥ 0` proven or assumed for `→ u`         | the assumption                          |
| `square-of-sqrt`    | `sqrt(u)^2 → u`, likewise `cbrt` and `nthRoot`                                                | —                                           | `u ≥ 0` (even roots)                    |
| `exp-ln`            | `exp(ln(u)) → u`                                                                              | —                                           | `u > 0`                                 |
| `ln-exp`            | `ln(exp(u)) → u`, `ln(e^k) → k`                                                               | real (v1 always)                            | —                                       |
| `exp-product`       | `exp(a)·exp(b) → exp(a + b)`, `exp(a)^y → exp(y·a)`, `1/exp(a) → exp(-a)`                     | —                                           | —                                       |
| `abs-sign`          | `abs(u) → ±u`; `abs(u)/u → sign(u)`                                                           | sign of `u` proven or assumed for the first | the assumption; `u ≠ 0`                 |
| `parity`            | `f(-u) → -f(u)` for odd, `f(u)` for even functions (`sin`, `cos`, `abs`, …)                   | —                                           | —                                       |
| `special-values`    | `sin(0)`, `cos(0)`, `tan(0)`, `exp(0)`, `ln(1)`, `ln(e)`, exact `sqrt` and `abs` of rationals | —                                           | —                                       |
| `factor-out`        | a common kernel factor pulled out of a sum (printing only)                                    | —                                           | —                                       |

Anything not in the table is left alone (`sin(x)^2 + cos(x)^2` stays). `applied` lists the rules that changed something.

**The sign oracle** decides "proven". It is small, sound and incomplete; "unknown" never licenses a rewrite. It knows: assumed signs of names (`nonzero`, `positive`, `nonnegative`, `negative`, per call); signs of ℚ[π, e] constants (rigorous, as above); `exp(u)`, `cosh(u)` > 0; `abs(u)`, `sqrt(u)`, even roots and `u^(p/q)` ≥ 0; even powers and expanded perfect squares ≥ 0; `ln(u)` has the sign of `u − 1`; odd increasing functions (`sign`, `atan`, `sinh`, …) keep the sign of their argument; sums of non-negatives with one positive term are positive; products and quotients by sign rules.

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

No English is built in: `template.key` is the translation key, and `TEMPLATE_KEYS` lists every key, so an app test can check its translations. English reference texts to copy:

| Key                                     | English                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `derivation`                            | Differentiate with respect to {x} ({order} times).                             |
| `derivation.order`                      | Derivative number {order}.                                                     |
| `derivation.simplification`             | Simplify the result.                                                           |
| `derivative.constant`                   | {c} is a constant: its derivative is 0.                                        |
| `derivative.variable`                   | The derivative of {x} is 1.                                                    |
| `derivative.sum`                        | Differentiate each term separately.                                            |
| `derivative.constant-multiple`          | Keep the constant factor {c} and differentiate {f}.                            |
| `derivative.constant-divisor`           | Divide the derivative of {f} by the constant {c}.                              |
| `derivative.product`                    | Product rule for {f} times {g}.                                                |
| `derivative.quotient`                   | Quotient rule for {f} over {g}.                                                |
| `derivative.power`                      | Power rule with exponent {n}.                                                  |
| `derivative.exponential`                | Exponential rule with base {a}.                                                |
| `derivative.exponential.e`              | The exponential function is its own derivative.                                |
| `derivative.general-power`              | Write the power as an exponential of a logarithm and differentiate.            |
| `derivative.logarithm`                  | The derivative of the natural logarithm is one over its argument.              |
| `derivative.logarithm.base`             | Logarithm to base {b}: divide by ln({b}).                                      |
| `derivative.root.sqrt`, `.cbrt`, `.nth` | Write the root as a power and use the power rule.                              |
| `derivative.absolute-value`             | The derivative of the absolute value is the sign, where the argument is not 0. |
| `derivative.chain`                      | Chain rule: the outer derivative times the derivative of {u}.                  |
| `derivative.repeat`                     | Already differentiated in step {of}.                                           |
| `derivative.function.sin` … `.acoth`    | The derivative of sin is cos (one key per function).                           |
| `simplify.normal-form`                  | Expand, collect like terms and cancel common factors.                          |
| `simplify.<rule>`                       | One per rule of the table above (`simplify.exp-ln`, …, `simplify.factor-out`). |

## Budgets

Every call checks `nodes`, `depth`, `terms`, `degree`, `gcdDegree`, `digits` and `fuel` (defaults 5 000, 256, 10 000, 1 000, 64, 1 000, 100 000) before the expensive work; `derivative` and `derivation` also check `order` (10) before starting, and a derivation checks `steps` (2 000; two per distinct subterm plus 16, before each order) and `stepNodes` (50 000 printed nodes, before printing the steps). A derivation spends more fuel than `derivative`: it simplifies once more per rule it shows. The readable normal form puts a sum of unrelated fractions over one denominator, so a high order of such a sum can reach the `terms` or `fuel` budget; rewriting has no static bound, so each `simplify` rewrite also costs fuel and throws `CasLimitError` (a `ResourceLimitError`) with `budget`, `limit` and `actual`. `signal` is checked every 1 024 fuel units. Input errors are `CasError` (a `MathError`) with a `code` and a one-sentence `remediation`.
