# @arki/expr

A safe expression language on [`@arki/math`](../math): a hand-written parser for user-typed formulas (`2x^2 + sin(x)`, `|x - 1|`, `√2`, `1/2x`), a typed and versioned AST with source spans, and canonical printing for storage. The root entry holds no numeric code; evaluation lives in domain entries (`@arki/expr/float`, `@arki/expr/decimal`, `@arki/expr/rational`, `@arki/expr/complex`), and `@arki/expr/latex` prints LaTeX. The design is specified in `docs/rfcs/2026-10-14-arki-expr.md`.

## Install

```sh
bun add @arki/expr @arki/math
```

## Quick start

Parse a formula a user typed, print it in the form you store, then evaluate it in the domain you pick.

```ts run
import { parse, print } from '@arki/expr';
import { evaluate } from '@arki/expr/decimal';

const stored = print(parse('2x^2 + sin(x)'));
if (stored !== '2 * x^2 + sin(x)') throw new Error(`unexpected canonical form: ${stored}`);

const sum = evaluate('0.1 + 0.2').toString();
if (sum !== '0.3') throw new Error(`decimal sum drifted: ${sum}`); // not 0.30000000000000004
```

The longer example below shows names, warnings, other syntaxes and errors.

### More parsing

```ts
import { decimalComma, names, parse, print } from '@arki/expr';

const expr = parse('2x^2 + sin(x)');
print(expr); // '2 * x^2 + sin(x)' — the canonical form to store
print(expr, { style: 'display' }); // '2x^2 + sin(x)'
names(expr); // { variables: ['x'], constants: [], functions: ['sin'] }

parse('1/2x').warnings[0]?.hint; // 'write (1/2)x or 1/(2x)'
print(parse('log(0,5; 2)', { syntax: decimalComma })); // 'log(0.5, 2)'

// parse('foo(x)') throws ParseError { code: 'not-a-function', span: { start: 0, end: 3 } }
```

`walk(node, visit)` visits a parsed tree parent first, left to right; return `false` from `visit` to skip that node's children. It uses a loop, so deep trees never overflow the stack. `syntaxFor(locale)` picks the `decimalComma` preset for locales that write `1,5`, and `canonical` otherwise. It throws `UnsupportedFeatureError` where `Intl.NumberFormat#formatToParts` is missing (Hermes on iOS); pass a preset there.

A name followed by `(` is a call only when the language registers it as a function. To read a variable before `(` as a product (`x(y+1)`), pass the variables: `parse('x(y+1)', { variables: ['x', 'y'] })`.

## When not to use this

- You need symbolic algebra (simplify, differentiate, factor). Use `@arki/cas`, which builds on this package.
- You need a full programming language: member access, strings, assignment or imports. This grammar has none of them, by design.
- You evaluate trusted numeric code in a hot loop and do not take user text. Write a plain function.
- You need matrices or units inside the expression. The language has numbers, names and functions only.

## Runtime support

Pure TypeScript with no `eval`, no `new Function`, and no Node built-ins. It runs wherever `@arki/math` runs: Node, Bun, Deno, browsers and Hermes. The depending `@arki/math` package carries the cross-engine results table.

## Public imports

| Import                | What it gives you                                                         |
| --------------------- | ------------------------------------------------------------------------- |
| `@arki/expr`          | `parse`, `parseEquation`, `print`, `names`, `fromJSON`, languages, errors |
| `@arki/expr/float`    | `compile`, `compileEquation`, `evaluate` on `number`                      |
| `@arki/expr/decimal`  | The same verbs on `Decimal`, with `scale` and `rounding`                  |
| `@arki/expr/rational` | The same verbs on `Rational`, never rounding                              |
| `@arki/expr/complex`  | The same verbs on `Complex`                                               |
| `@arki/expr/latex`    | `toLatex`                                                                 |

## Failure behaviour

Every failure throws. Nothing returns `NaN`, `Infinity` or a half-built value.

- **Bad text or a bad stored AST:** `ParseError`. Read `code` (`unexpected-token`, `unknown-name`, `arity`, `not-in-domain`, and the others in `ParseErrorCode`), `span` for the caret, and `expected` for what would fit. Show the user the span; do not retry the same text.
- **Over a budget:** `ExprLimitError` with `budget`, `limit` and `actual`. Reject the input or raise the budget on purpose.
- **A value with no result** (`sqrt(-1)`, `x/0`, overflow): the typed errors of `@arki/math` (`InvalidArgumentError`, `DivisionByZeroError`, `NumericRangeError`). In the Decimal and Rational domains a step that would round throws `RoundingNecessaryError` until you pass a rounding mode.
- **Plot gaps:** `f.sample` is the one call that returns `NaN`, and only to mark a point with no value.

Catch `ParseError` at the edge where users type. Let the other errors reach your error boundary.

## Limits

Every input has a budget. A text, an AST or a call that goes over one throws `ExprLimitError` before the costly work starts.

| Budget                               | Default                   | Checked                                                                                                                                                                       |
| ------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `length`, `tokens`, `depth`, `nodes` | 10 000, 5 000, 256, 5 000 | while parsing, in `fromJSON`, and `depth` again in `compile`, `print` and `toLatex`                                                                                           |
| `steps`                              | 10 000 000                | statically: nodes (plus each host function's declared `cost`) per call, times the points for `sample`                                                                         |
| `digits` (exact domains)             | 1 000                     | literal digits at compile; a power (≈ exponent × digits of the base) or factorial (log-gamma) result before computing it: `9^9^9` and `10000!` throw `ExprLimitError` at once |

`sample` checks `{ signal }` every 1 024 points. Compiled functions are closures: no `eval`, no `new Function`. Bundle budgets (min + gzip, checked by `size-limit` in `test`): root ≤ 6 kB, root + float ≤ 15 kB, latex ≤ 3 kB; root + decimal, root + rational and root + complex ≤ 10 kB each with `@arki/math` left out (the 6 kB core budget plus 4 kB of domain glue), and the full cost with the `@arki/math` subpaths they import is gated too (≈ 17.4 kB decimal, ≈ 14.7 kB rational, ≈ 13 kB complex).

Boundary example: a text of 10 001 characters throws `ExprLimitError` with `budget: 'length'`, `limit: 10000` and `actual: 10001`. A text of 10 000 characters parses.

```ts run
import { ExprLimitError, parse } from '@arki/expr';

parse('x'.repeat(10_000)); // parses
let caught: ExprLimitError | undefined;
try {
  parse('x'.repeat(10_001));
} catch (error) {
  if (error instanceof ExprLimitError) caught = error;
}
if (caught?.budget !== 'length' || caught.limit !== 10_000 || caught.actual !== 10_001) {
  throw new Error('the length budget did not trip at 10 001');
}
```

## Documentation

- [Agent guide](docs/agent-guide.md): the model, the task map and the rules.
- [llms.txt](llms.txt): the short index for agents.
- [CHANGELOG](CHANGELOG.md): what changed in each version.
- Design: `docs/rfcs/2026-10-14-arki-expr.md` in the Arki workspace.

## Support

Report a bug or ask a question in the [Arki issue tracker](https://github.com/arki-labs/arki/issues). Include the expression text, the domain and the error `code`.

## Security model

The language can only do what the host registered. The grammar has no member access, indexing, strings, assignment or imports; function and constant names resolve through private `Map`s, so `constructor`, `__proto__` or `toString` are names that are not there. The lexer is a single hand-written pass with no regular expressions, and every input is bounded before the expensive work: length before lexing, tokens while lexing, tree depth and node count while parsing (a 100 000-paren input throws `ExprLimitError`, never `RangeError`). Stored ASTs are re-validated by `fromJSON`, field by field and against the same budgets. There is no `eval` and no `new Function`.

## Float (`@arki/expr/float`)

```ts
import { parse, parseEquation } from '@arki/expr';
import { compile, compileEquation, evaluate } from '@arki/expr/float';

evaluate('2^10 - 1'); // 1023, for the keypad
evaluate('sin(90)', { angle: 'deg' }); // 1

const xs = new Float64Array([0, 0.5, 1]);
const out = new Float64Array(xs.length);
const f = compile(parse('2x^2 + sin(x)'), { variables: ['x'] });
f({ x: 1.5 }); // typed errors, never NaN or Infinity
f.at(1.5); // one variable, no scope object
f.sample(xs, out); // Float64Array in and out; NaN marks a gap in a plot

const { left, right, difference } = compileEquation(parseEquation('x^2 = 2x'), { variables: ['x'] });
```

- **Errors, not NaN.** `f()` and `f.at()` throw `@arki/math`'s errors: `sqrt(-1)` and `ln(0)` are `InvalidArgumentError`, `x/0` is `DivisionByZeroError`, overflow is `NumericRangeError`. `sample` is the only call that returns `NaN`: it marks a point with no value.
- **Names resolve at compile.** A declared variable or a constant wins; otherwise a multi-letter name splits into declared letters (`xy` → `x·y`, listed in `f.readings`); otherwise `unknown-name` with a span. Declaring `pi` as a variable is `name-conflict`. `a/bc` read as `a/(b·c)` adds a `split-after-division` warning.
- **Degrees** apply to forward-trig arguments and inverse-trig results at any depth; multiples of 90° are exact (`sin(180°)` is `0`, `tan(90°)` is an error).
- **Host names.** Pass the language to `compile`; the types then require an implementation for every function and constant it adds to `scientific`. Host functions receive numbers only.

## Decimal (`@arki/expr/decimal`)

```ts
import { parse } from '@arki/expr';
import { compile, evaluate } from '@arki/expr/decimal';

evaluate('0.1 + 0.2').toString(); // '0.3' — literals are read from their text

const price = compile(parse('base * (1 + rate)'), { variables: ['base', 'rate'], scale: 2, rounding: 'halfEven' });
price({ base: '19.99', rate: '0.19' }).toString(); // '23.7881' — multiplication never rounds
compile(parse('total / 3'), { variables: ['total'], scale: 2, rounding: 'halfEven' })({ total: '10' }).toString(); // '3.33'
compile(parse('1/3 * 3'), { scale: 4, rounding: 'halfEven' }).detailed(); // { value: 0.9999, exact: false } — show ≈
```

- **Exact or rounded where you said.** `+ - *` and integer powers never round. `/` is exact when the quotient terminates (`1/8` is `0.125` at any scale) and otherwise rounds to `{ scale, rounding }`. Functions — `sqrt cbrt nthRoot exp ln log log10 log2`, non-integer powers — and the constants `pi`, `e` return their correctly rounded value at `scale` (default 20).
- **The default rounding is `'unnecessary'`**, like `Decimal#dividedBy`: a step that would round throws `RoundingNecessaryError` until you choose a mode.
- **`f.detailed(scope)`** returns `{ value, exact }`; `exact` is false once any step rounded, including a folded constant such as `pi`.
- **No silent float.** Trigonometry and `i` are a compile-time `ParseError` `not-in-domain` pointing at the call. A host that wants float trig on decimals registers it as a host function and says so.
- `factorial` (integers only), `mod` (floored), `floor`, `ceil`, `round` (half away from zero), `fix`, `sign`, `abs` are exact. Scope values accept what `decimal()` accepts; host functions receive and return `Decimal`s.

## Rational (`@arki/expr/rational`)

```ts
import { evaluate } from '@arki/expr/rational';

evaluate('1/3 + 1/6').toString(); // '1/2'
evaluate('8^(2/3)').toString(); // '4'
evaluate('2^(1/2)'); // throws RoundingNecessaryError: the exact answer exists, a Rational cannot hold it
```

Never rounds. `sqrt`, `cbrt`, `nthRoot` and non-integer powers return a value only when it is rational. `exp`, the logarithms, trigonometry and `pi`, `e`, `i` are `not-in-domain` at compile, with no special cases such as `ln(1) = 0`; `e` and `i` are then free to be declared as variables. Same verbs as the other domains: `compile`, `compileEquation`, `evaluate`, `f(scope)`, `f.detailed` (always exact), `f.readings`, `f.warnings`, `f.variables`.

Both exact domains fold constant subtrees at compile and take `{ signal }` per call (`f(scope, { signal })`, `evaluate(text, { signal })`): it is checked before each operation on a value above 100 digits.

## Complex (`@arki/expr/complex`)

```ts
import { parse } from '@arki/expr';
import { compile, evaluate } from '@arki/expr/complex';

evaluate('sqrt(-4)').toString(); // '2i'
evaluate('ln(-1)').toString(); // '3.141592653589793i'
evaluate('i^i').toString(); // '0.20787957635076193' (e^(-π/2))
compile(parse('z^2 + 1'), { variables: ['z'] })({ z: { re: 0, im: 1 } }).toString(); // '0'
```

Values are `Complex` from `@arki/math/complex`: float64 parts, never exact, so `f.detailed()` always reports `exact: false`. Principal branches as `@arki/math/complex` defines them (C99 Annex G, Kahan's counter-clockwise rule on the cuts: `asin(2)` is `π/2 − 1.317i`, as in mathjs and Mathematica). On the real axis, wherever the float domain has a value, this domain returns exactly that value (`log10(1000)` is 3, `cos(90)` in degrees is 0); it leaves the axis only where float has no real answer (`sqrt(-2)`, `asin(2)`, `(-8)^(1/3)`).

- `i` is a constant: declaring a variable `i` is a `name-conflict` here, and only here.
- Functions: trigonometry, hyperbolics and their inverses (all with reciprocals), `exp ln log log10 log2 sqrt pow abs` (`abs` is a real-valued `Complex`). `cbrt` and `nthRoot` are `not-in-domain`: float's real root (`cbrt(-8) = -2`) and the principal root (`1 + 1.732i`) are different numbers, so neither is picked silently; write `x^(1/3)` for the principal one. `sign ceil floor round fix mod factorial gamma` (and `n!`) are `not-in-domain`: `@arki/math` has no complex definition for them.
- `angle: 'deg'` measures real angles: trigonometry takes a real argument and an inverse must return a real angle, computed as float does; anything else is `InvalidArgumentError`.
- Errors: `x/0` is `DivisionByZeroError`, overflow `NumericRangeError`, a pole (`ln(0)`, `cot(0)`) `InvalidArgumentError`. No result has a `NaN` or infinite part.
- Scope values and host constants: a `Complex`, a finite number (a real), or finite `{ re, im }` parts. Text is not a value; parse it. Host functions receive and return `Complex`es.
- Same verbs as the exact domains (`compile`, `compileEquation`, `evaluate`, `f(scope)`, `f.detailed`, `f.readings`, `f.warnings`, `f.variables`), the same compile budgets and constant folding.

## LaTeX (`@arki/expr/latex`)

```ts
import { parse } from '@arki/expr';
import { toLatex } from '@arki/expr/latex';

toLatex(parse('sqrt(x)/2 + |x|')); // '\\frac{\\sqrt{x}}{2} + \\left|x\\right|'
```

`\frac` for `/`, `^{}`, `\sqrt[n]{}`, `\sin`-style commands, `\pi`, `n!`, `\cdot` for an explicit `*` and juxtaposition for an implicit one. Host functions use their language `latex` command, otherwise `\operatorname{name}`.
