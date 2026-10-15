/**
 * `@arki/failure/eslint` — the `must-use` rule.
 *
 * A failure is a return value, so the compiler forces a check only when the
 * value is used. A call whose result is thrown away (`await remove(id);` on a
 * `Promise<void | Failure>`) drops its failure silently. This type-aware rule
 * reports that statement. Discard on purpose with `void remove(id)`.
 *
 * @example
 * // eslint.config.js
 * import failure from '@arki/failure/eslint';
 * export default [failure.configs.recommended];
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
        'This call can return a failure ({{codes}}) and its result is thrown away. Handle it, return it, or discard it on purpose with `void`.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    return {
      ExpressionStatement(node) {
        if (!isCall(node.expression)) return;
        const type = services.getTypeAtLocation(node.expression);
        const codes = failureCodes(checker, checker.getAwaitedType(type) ?? type);
        if (codes.length > 0) context.report({ node, messageId: 'mustUse', data: { codes: codes.join(', ') } });
      },
    };
  },
});

/** A call, optionally awaited or optional-chained. Assignments, `void x` and other expressions are not discards of a result. */
function isCall(expression: TSESTree.Expression): boolean {
  const inner = expression.type === AST_NODE_TYPES.AwaitExpression ? expression.argument : expression;
  const call = inner.type === AST_NODE_TYPES.ChainExpression ? inner.expression : inner;
  return call.type === AST_NODE_TYPES.CallExpression || call.type === AST_NODE_TYPES.NewExpression;
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

/** The plugin, with a flat `recommended` config that registers it as `failure` and turns `failure/must-use` on. */
const plugin: TSESLint.FlatConfig.Plugin & { configs: { recommended: TSESLint.FlatConfig.Config } } = {
  meta: { name: '@arki/failure' },
  rules,
  configs: {
    recommended: {
      plugins: { failure: { meta: { name: '@arki/failure' }, rules } },
      rules: { 'failure/must-use': 'error' },
    },
  },
};

export default plugin;
