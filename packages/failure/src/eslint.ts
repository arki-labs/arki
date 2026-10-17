/**
 * `@arki/failure/eslint` — the `must-use` rule.
 *
 * A failure is a return value, so the compiler forces a check only when the
 * value is used. A call whose result is thrown away (`await remove(id);` on a
 * `Promise<void | Failure>`) drops its failure silently. This type-aware rule
 * reports that statement, also under `void` and inside a discarded `Promise.all`.
 * Drop one on purpose with `// eslint-disable-next-line failure/must-use -- <reason>`.
 *
 * @example
 * // eslint.config.js
 * import failure from '@arki/failure/eslint';
 * export default [failure.configs.recommended]; // TypeScript files only
 */
import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type { Type, TypeChecker } from 'typescript';
import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';

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

const rules = { 'must-use': mustUse };

/**
 * The plugin, with a flat `recommended` config that registers it as `failure` and turns
 * `failure/must-use` on for TypeScript files only: the rule needs type information, which
 * plain `.js` files (such as `eslint.config.js`) do not have.
 */
const plugin: TSESLint.FlatConfig.Plugin & { configs: { recommended: TSESLint.FlatConfig.Config } } = {
  meta: { name: '@arki/failure' },
  rules,
  configs: {
    recommended: {
      files: ['**/*.{ts,tsx,mts,cts}'],
      plugins: { failure: { meta: { name: '@arki/failure' }, rules } },
      rules: { 'failure/must-use': 'error' },
    },
  },
};

export default plugin;
