# @arki/expr

A safe expression language on [`@arki/math`](../math): a hand-written parser for user-typed formulas (`2x^2 + sin(x)`, `|x - 1|`, `√2`, `1/2x`), a typed and versioned AST with source spans, and canonical printing for storage. This entry holds no numeric code; evaluation domains build on its AST. The design is specified in `docs/rfcs/2026-10-14-arki-expr.md`.

## Security model

The language can only do what the host registered. The grammar has no member access, indexing, strings, assignment or imports; function and constant names resolve through private `Map`s, so `constructor`, `__proto__` or `toString` are just names that are not there. The lexer is a single hand-written pass with no regular expressions, and every input is bounded before the expensive work: length before lexing, tokens while lexing, tree depth and node count while parsing (a 100 000-paren input throws `ExprLimitError`, never `RangeError`). Stored ASTs are re-validated by `fromJSON`, field by field and against the same budgets. There is no `eval` and no `new Function`.

## Example

```ts
import { decimalComma, names, parse, print } from '@arki/expr';

const expr = parse('2x^2 + sin(x)');
print(expr); // '2 * x^2 + sin(x)' — the canonical form to store
print(expr, { style: 'display' }); // '2x^2 + sin(x)'
names(expr); // { variables: ['x'], constants: [], functions: ['sin'] }

parse('1/2x').warnings[0]?.hint; // 'write (1/2)x or 1/(2x)'
print(parse('log(0,5; 2)', { syntax: decimalComma })); // 'log(0.5, 2)'

parse('foo(x)'); // throws ParseError { code: 'not-a-function', span: { start: 0, end: 3 } }
```

A name followed by `(` is a call only when the language registers it as a function. To read a variable before `(` as a product (`x(y+1)`), pass the variables: `parse('x(y+1)', { variables: ['x', 'y'] })`.
