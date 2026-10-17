/**
 * `@arki/failure/eslint` — the `must-use` and `no-blind-accept` rules.
 *
 * A failure is a return value, so the compiler forces a check only when the
 * value is used. A call whose result is thrown away (`await remove(id);` on a
 * `Promise<void | Failure>`) drops its failure silently. This type-aware rule
 * reports that statement, also under `void` and inside a discarded `Promise.all`.
 * Drop one on purpose with `// eslint-disable-next-line failure/must-use -- <reason>`.
 * `no-blind-accept` reports `accept(r)` when `r` was not checked by kind (see {@link noBlindAccept}).
 *
 * @example
 * // eslint.config.js
 * import failure from '@arki/failure/eslint';
 * export default [failure.configs.recommended]; // TypeScript files only
 */
import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type { Type, TypeChecker } from 'typescript';
import { AST_NODE_TYPES, AST_TOKEN_TYPES, ESLintUtils } from '@typescript-eslint/utils';

/** The brand every failure type carries (see `Failure` in the core entry). */
const BRAND = '~failure';

const createRule = ESLintUtils.RuleCreator(name => `https://arki.dev/failure/eslint#${name}`);

/** Report a statement that discards a call which may return a failure. */
export const mustUse = createRule({
  name: 'must-use',
  meta: {
    type: 'problem',
    docs: { description: 'Disallow discarding the result of a call that may return a failure' },
    messages: {
      mustUse:
        'This call can return a failure ({{codes}}) and its result is thrown away. Handle it or return it. To drop it on purpose, add `// eslint-disable-next-line failure/must-use -- <reason>`.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    return {
      ExpressionStatement(node) {
        const call = discardedCall(node.expression);
        if (call === undefined) return;
        const type = services.getTypeAtLocation(call);
        const result = checker.getAwaitedType(type) ?? type;
        const codes = new Set(resultTypes(checker, call, result).flatMap(part => failureCodes(checker, part)));
        if (codes.size > 0) context.report({ node, messageId: 'mustUse', data: { codes: [...codes].join(', ') } });
      },
    };
  },
});

type Call = TSESTree.CallExpression | TSESTree.NewExpression;

/**
 * The call a statement throws away: a call, optionally under `void`, awaited or optional-chained.
 * `void` is not an opt-out: it hides the failure just as well. Assignments are left to the
 * compiler and the unused-variable rules.
 */
function discardedCall(expression: TSESTree.Expression): Call | undefined {
  const kept =
    expression.type === AST_NODE_TYPES.UnaryExpression && expression.operator === 'void'
      ? expression.argument
      : expression;
  const inner = kept.type === AST_NODE_TYPES.AwaitExpression ? kept.argument : kept;
  const call = inner.type === AST_NODE_TYPES.ChainExpression ? inner.expression : inner;
  return call.type === AST_NODE_TYPES.CallExpression || call.type === AST_NODE_TYPES.NewExpression ? call : undefined;
}

/**
 * The types that may hold a failure: the result itself, plus each item's result for
 * `Promise.all` and `Promise.allSettled`, which return an array, not a union.
 * (`Promise.any` and `Promise.race` already return a union of the item results.)
 */
function resultTypes(checker: TypeChecker, call: Call, result: Type): Type[] {
  const method = promiseCombinator(call);
  const item = method === undefined ? undefined : result.getNumberIndexType();
  if (item === undefined) return [result];
  if (method === 'all') return [result, item];
  // An allSettled item is `PromiseFulfilledResult<T> | PromiseRejectedResult`; the failure sits in `value`.
  const settled = item.isUnion() ? item.types : [item];
  return [
    result,
    ...settled.flatMap(part => {
      const value = part.getProperty('value');
      return value === undefined ? [] : [checker.getTypeOfSymbol(value)];
    }),
  ];
}

/** `all` or `allSettled` when the call is `Promise.all(...)` or `Promise.allSettled(...)`. */
function promiseCombinator(call: Call): 'all' | 'allSettled' | undefined {
  const callee = call.callee;
  if (callee.type !== AST_NODE_TYPES.MemberExpression || callee.computed) return undefined;
  if (callee.object.type !== AST_NODE_TYPES.Identifier || callee.object.name !== 'Promise') return undefined;
  if (callee.property.type !== AST_NODE_TYPES.Identifier) return undefined;
  const name = callee.property.name;
  return name === 'all' || name === 'allSettled' ? name : undefined;
}

/** The codes of the failures a type may be; empty when it cannot be a failure. */
function failureCodes(checker: TypeChecker, type: Type): string[] {
  const parts = type.isUnion() ? type.types : [type];
  const codes: string[] = [];
  for (const part of parts) {
    if (part.getProperty(BRAND) === undefined) continue;
    const code = part.getProperty('code');
    codes.push(code === undefined ? 'a failure' : checker.typeToString(checker.getTypeOfSymbol(code)));
  }
  return codes;
}

/**
 * Report `accept(x)` when `x` is not checked by kind.
 *
 * `accept` lifts the "doomed command" rule (`@arki/journal`) for one refusal the handler checked.
 * `if (isFailure(r)) accept(r)` accepts every refusal, including codes the callee adds later, so it
 * defeats the rule. Check the kind first: `if (OutOfStock.is(r)) { accept(r); … }`.
 *
 * "Checked by kind" is decided from types: every part of `x`'s type at the call is a failure with
 * a literal `code`. One code is enough. With two or more codes, the type alone cannot tell
 * `isFailure(r)` from `A.is(r) || B.is(r)` (both narrow to `A | B`), so the rule also reads the
 * nearest condition that mentions `x`: each of its `||` branches must be a non-generic guard
 * whose type predicate names exactly one code. `isFailure<Value>` is generic, so it never counts.
 */
export const noBlindAccept = createRule({
  name: 'no-blind-accept',
  meta: {
    type: 'problem',
    docs: { description: 'Disallow accepting a failure that was not checked by kind' },
    messages: {
      noBlindAccept:
        '{{name}}() needs a refusal you checked by kind (`Def.is(x)`), not any failure. Check the specific failure first.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: 'The call names to check.' },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ names: ['accept'] }],
  create(context, [{ names }]) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    /** A guard that narrows `subject` to exactly one failure code, such as `OutOfStock.is(r)`. */
    const checksKind = (test: TSESTree.Expression, subject: string): boolean => {
      if (test.type === AST_NODE_TYPES.LogicalExpression && test.operator === '||')
        return checksKind(test.left, subject) && checksKind(test.right, subject);
      if (test.type === AST_NODE_TYPES.LogicalExpression && test.operator === '&&')
        return checksKind(test.left, subject) || checksKind(test.right, subject);
      if (test.type !== AST_NODE_TYPES.CallExpression) return false;
      const signature = checker.getResolvedSignature(services.esTreeNodeToTSNodeMap.get(test));
      // A generic guard such as `isFailure<Value>` narrows to whatever its argument may be, so it names no kind.
      if (signature === undefined || (signature.getDeclaration().typeParameters?.length ?? 0) > 0) return false;
      const predicate = checker.getTypePredicateOfSignature(signature);
      if (predicate?.type === undefined || predicate.parameterIndex === undefined) return false;
      const argument = test.arguments[predicate.parameterIndex];
      if (argument?.type !== AST_NODE_TYPES.Identifier || argument.name !== subject) return false;
      const narrowed = kinds(checker, predicate.type);
      return narrowed.codes.size === 1 && !narrowed.wide && !narrowed.plain;
    };

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === undefined || !names.includes(name)) return;
        const argument = node.arguments[0];
        if (argument === undefined || argument.type === AST_NODE_TYPES.SpreadElement) return;
        const found = kinds(checker, services.getTypeAtLocation(argument));
        // Not a failure at all (such as `dialog.accept('yes')`): another API's `accept`.
        if (found.codes.size === 0 && !found.wide) return;
        const blind =
          found.plain ||
          found.wide ||
          (found.codes.size > 1 && !guardedByKind(context.sourceCode, node, argument, checksKind));
        if (blind) context.report({ node, messageId: 'noBlindAccept', data: { name } });
      },
    };
  },
});

/** `accept` for `accept(x)`, `ctx.accept(x)` and `ctx?.accept(x)`; undefined for other callees. */
function calleeName(callee: TSESTree.Expression): string | undefined {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name;
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    !callee.computed &&
    callee.property.type === AST_NODE_TYPES.Identifier
  )
    return callee.property.name;
  return undefined;
}

/**
 * True when the nearest condition that mentions `argument` (an `if` or `?:` around the call, or
 * the left of `&&`) checks it by kind. False when there is none, or `argument` is not a plain variable.
 */
function guardedByKind(
  sourceCode: TSESLint.SourceCode,
  call: TSESTree.CallExpression,
  argument: TSESTree.Expression,
  checksKind: (test: TSESTree.Expression, subject: string) => boolean,
): boolean {
  if (argument.type !== AST_NODE_TYPES.Identifier) return false;
  const subject = argument.name;
  let child: TSESTree.Node = call;
  for (let node: TSESTree.Node | undefined = call.parent; node !== undefined; child = node, node = node.parent) {
    if (
      node.type === AST_NODE_TYPES.FunctionDeclaration ||
      node.type === AST_NODE_TYPES.FunctionExpression ||
      node.type === AST_NODE_TYPES.ArrowFunctionExpression
    )
      return false;
    const test =
      (node.type === AST_NODE_TYPES.IfStatement || node.type === AST_NODE_TYPES.ConditionalExpression) &&
      node.consequent === child
        ? node.test
        : node.type === AST_NODE_TYPES.LogicalExpression && node.operator === '&&' && node.right === child
          ? node.left
          : undefined;
    if (test === undefined) continue;
    const mentions = sourceCode
      .getTokens(test)
      .some(token => token.type === AST_TOKEN_TYPES.Identifier && token.value === subject);
    if (mentions) return checksKind(test, subject);
  }
  return false;
}

/** What a type may be: the distinct literal failure codes, a failure with a wide code, a non-failure. */
function kinds(checker: TypeChecker, type: Type): { codes: Set<string>; wide: boolean; plain: boolean } {
  const found = { codes: new Set<string>(), wide: false, plain: false };
  for (const part of type.isUnion() ? type.types : [type]) {
    if (part.getProperty(BRAND) === undefined) {
      found.plain = true;
      continue;
    }
    const code = part.getProperty('code');
    const codeType = code === undefined ? undefined : checker.getTypeOfSymbol(code);
    const literals = codeType === undefined ? [] : codeType.isUnion() ? codeType.types : [codeType];
    if (literals.length === 0) found.wide = true;
    for (const literal of literals) {
      if (literal.isStringLiteral()) found.codes.add(literal.value);
      else found.wide = true;
    }
  }
  return found;
}

const rules = { 'must-use': mustUse, 'no-blind-accept': noBlindAccept };

/**
 * The plugin, with a flat `recommended` config that registers it as `failure` and turns
 * `failure/must-use` and `failure/no-blind-accept` on for TypeScript files only: the rules need
 * type information, which plain `.js` files (such as `eslint.config.js`) do not have.
 */
const plugin: TSESLint.FlatConfig.Plugin & { configs: { recommended: TSESLint.FlatConfig.Config } } = {
  meta: { name: '@arki/failure' },
  rules,
  configs: {
    recommended: {
      files: ['**/*.{ts,tsx,mts,cts}'],
      plugins: { failure: { meta: { name: '@arki/failure' }, rules } },
      rules: { 'failure/must-use': 'error', 'failure/no-blind-accept': 'error' },
    },
  },
};

export default plugin;
