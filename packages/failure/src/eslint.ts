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
import type { Node, Type, TypeChecker, Symbol as TypeSymbol } from 'typescript';
import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import {
  forEachChild,
  isBindingElement,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  NodeFlags,
  SymbolFlags,
  TypeFlags,
} from 'typescript';

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
        'This result can contain a failure ({{codes}}) and is thrown away. Handle it or return it. To drop it on purpose, add `// eslint-disable-next-line failure/must-use -- <reason>`.',
      callbackReturn:
        'This callback can return a failure ({{codes}}), but its return value is discarded by a void signature. Handle the failure before returning from the callback.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const checkedCallbacks = new Set<TSESTree.Expression>();
    const checkCallback = (expression: TSESTree.Expression): void => {
      if (checkedCallbacks.has(expression)) return;
      checkedCallbacks.add(expression);
      const tsNode = services.esTreeNodeToTSNodeMap.get(expression);
      if (!isExpression(tsNode)) return;
      const expected = checker.getContextualType(tsNode);
      const signatures =
        expected === undefined
          ? []
          : (expected.isUnion() ? expected.types : [expected]).flatMap(part => part.getCallSignatures());
      if (
        signatures.length === 0 ||
        !signatures.every(signature => (checker.getReturnTypeOfSignature(signature).flags & TypeFlags.Void) !== 0)
      )
        return;
      const codes = new Set(
        services
          .getTypeAtLocation(expression)
          .getCallSignatures()
          .flatMap(signature => resultTypes(checker, checker.getReturnTypeOfSignature(signature)))
          .flatMap(part => failureCodes(checker, part)),
      );
      if (codes.size > 0)
        context.report({ node: expression, messageId: 'callbackReturn', data: { codes: [...codes].join(', ') } });
    };
    const checkArguments = (node: Call): void => {
      for (const argument of node.arguments)
        if (argument.type !== AST_NODE_TYPES.SpreadElement) checkCallback(argument);
    };
    return {
      CallExpression: checkArguments,
      NewExpression: checkArguments,
      ArrowFunctionExpression: checkCallback,
      FunctionExpression: checkCallback,
      VariableDeclarator(node) {
        if (node.init !== null) checkCallback(node.init);
      },
      AssignmentExpression(node) {
        checkCallback(node.right);
      },
      AssignmentPattern(node) {
        checkCallback(node.right);
      },
      Property(node) {
        if (node.value.type === AST_NODE_TYPES.Identifier || node.value.type === AST_NODE_TYPES.MemberExpression)
          checkCallback(node.value);
      },
      ExpressionStatement(node) {
        const codes = new Set(
          discardedValues(node.expression).flatMap(value =>
            resultTypes(checker, services.getTypeAtLocation(value)).flatMap(part => failureCodes(checker, part)),
          ),
        );
        if (codes.size > 0) context.report({ node, messageId: 'mustUse', data: { codes: [...codes].join(', ') } });
      },
    };
  },
});

type Call = TSESTree.CallExpression | TSESTree.NewExpression;

/**
 * The values a statement throws away, under `void`, await, optional chains and branches.
 * `void` is not an opt-out: it hides the failure just as well. Assignments are left to the
 * compiler and the unused-variable rules.
 */
function discardedValues(expression: TSESTree.Expression): TSESTree.Expression[] {
  if (expression.type === AST_NODE_TYPES.UnaryExpression && expression.operator === 'void')
    return discardedValues(expression.argument);
  if (expression.type === AST_NODE_TYPES.AwaitExpression) return discardedValues(expression.argument);
  if (expression.type === AST_NODE_TYPES.ChainExpression) return discardedValues(expression.expression);
  if (expression.type === AST_NODE_TYPES.LogicalExpression)
    return [...discardedValues(expression.left), ...discardedValues(expression.right)];
  if (expression.type === AST_NODE_TYPES.ConditionalExpression)
    return [...discardedValues(expression.consequent), ...discardedValues(expression.alternate)];
  if (expression.type === AST_NODE_TYPES.SequenceExpression)
    return expression.expressions.flatMap(part => discardedValues(part));
  return expression.type === AST_NODE_TYPES.AssignmentExpression ? [] : [expression];
}

/**
 * Result containers with a defined consumption protocol: arrays/tuples, fulfilled
 * settled results and iterator results. Follow their values through forwarding helpers,
 * without treating arbitrary object properties as discarded failures.
 */
function resultTypes(checker: TypeChecker, type: Type, seen = new Set<Type>()): Type[] {
  const result = checker.getAwaitedType(type) ?? type;
  if (seen.has(result)) return [];
  seen.add(result);
  if (result.isUnion()) return result.types.flatMap(part => resultTypes(checker, part, seen));
  const children: Type[] = [];
  if (checker.isArrayType(result) || checker.isTupleType(result)) {
    const item = result.getNumberIndexType();
    if (item !== undefined) children.push(item);
  }
  const value = result.getProperty('value');
  if (value !== undefined) {
    const status = result.getProperty('status');
    const statusType = status === undefined ? undefined : checker.getTypeOfSymbol(status);
    const done = result.getProperty('done');
    const doneType = done === undefined ? undefined : checker.getTypeOfSymbol(done);
    const iteratorResult =
      doneType !== undefined &&
      (doneType.isUnion() ? doneType.types : [doneType]).every(
        part => (part.flags & (TypeFlags.BooleanLike | TypeFlags.Undefined)) !== 0,
      );
    if ((statusType?.isStringLiteral() === true && statusType.value === 'fulfilled') || iteratorResult)
      children.push(checker.getTypeOfSymbol(value));
  }
  return [result, ...children.flatMap(child => resultTypes(checker, child, seen))];
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
 * Every part of `x`'s type must be a failure with a literal `code`. The nearest condition
 * about it must check a named kind or an exact code; a bare `isFailure` is blind even when
 * today's result has only one refusal. Const aliases keep the same subject identity.
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
    const checksKind = (test: TSESTree.Expression, subject: TypeSymbol): boolean => {
      if (test.type === AST_NODE_TYPES.LogicalExpression && test.operator === '||')
        return checksKind(test.left, subject) && checksKind(test.right, subject);
      if (test.type === AST_NODE_TYPES.LogicalExpression && test.operator === '&&')
        return checksKind(test.left, subject) || checksKind(test.right, subject);
      if (test.type === AST_NODE_TYPES.BinaryExpression && test.operator === '===') {
        const codeAccess = (expression: TSESTree.Expression): boolean =>
          expression.type === AST_NODE_TYPES.MemberExpression &&
          expression.object.type === AST_NODE_TYPES.Identifier &&
          subjectSymbol(checker, services.esTreeNodeToTSNodeMap.get(expression.object)) === subject &&
          ((!expression.computed &&
            expression.property.type === AST_NODE_TYPES.Identifier &&
            expression.property.name === 'code') ||
            (expression.computed &&
              expression.property.type === AST_NODE_TYPES.Literal &&
              expression.property.value === 'code'));
        return (
          (codeAccess(test.left) && services.getTypeAtLocation(test.right).isStringLiteral()) ||
          (codeAccess(test.right) && services.getTypeAtLocation(test.left).isStringLiteral())
        );
      }
      if (test.type !== AST_NODE_TYPES.CallExpression) return false;
      const signature = checker.getResolvedSignature(services.esTreeNodeToTSNodeMap.get(test));
      // A generic guard such as `isFailure<Value>` narrows to whatever its argument may be, so it names no kind.
      if (signature === undefined || (signature.getDeclaration().typeParameters?.length ?? 0) > 0) return false;
      const predicate = checker.getTypePredicateOfSignature(signature);
      if (predicate?.type === undefined || predicate.parameterIndex === undefined) return false;
      const argument = test.arguments[predicate.parameterIndex];
      if (
        argument?.type !== AST_NODE_TYPES.Identifier ||
        subjectSymbol(checker, services.esTreeNodeToTSNodeMap.get(argument)) !== subject
      )
        return false;
      const narrowed = kinds(checker, predicate.type);
      return narrowed.codes.size === 1 && !narrowed.wide && !narrowed.plain;
    };

    return {
      CallExpression(node) {
        const name = checkedCallee(checker, services.esTreeNodeToTSNodeMap.get(node.callee), names);
        if (name === undefined) return;
        const argument = node.arguments[0];
        if (argument === undefined || argument.type === AST_NODE_TYPES.SpreadElement) return;
        const found = kinds(checker, services.getTypeAtLocation(argument));
        // Not a failure at all (such as `dialog.accept('yes')`): another API's `accept`.
        if (found.codes.size === 0 && !found.wide) return;
        const subject =
          argument.type === AST_NODE_TYPES.Identifier
            ? subjectSymbol(checker, services.esTreeNodeToTSNodeMap.get(argument))
            : undefined;
        const guard =
          subject === undefined
            ? undefined
            : guardedByKind(
                node,
                test => mentionsSubject(checker, services.esTreeNodeToTSNodeMap.get(test), subject),
                test => checksKind(test, subject),
              );
        const blind = found.plain || found.wide || guard === false || (found.codes.size > 1 && guard !== true);
        if (blind) context.report({ node, messageId: 'noBlindAccept', data: { name } });
      },
    };
  },
});

/** Resolve configured entrypoints through imports, const aliases and object destructuring. */
function checkedCallee(
  checker: TypeChecker,
  callee: Node,
  names: readonly string[],
  seen = new Set<TypeSymbol>(),
): string | undefined {
  const symbol = isElementAccessExpression(callee)
    ? (() => {
        const key = checker.getTypeAtLocation(callee.argumentExpression);
        return key.isStringLiteral()
          ? checker.getPropertyOfType(checker.getTypeAtLocation(callee.expression), key.value)
          : undefined;
      })()
    : checker.getSymbolAtLocation(isPropertyAccessExpression(callee) ? callee.name : callee);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const name = symbol.getName();
  if (names.includes(name)) return name;
  if ((symbol.flags & SymbolFlags.Alias) !== 0) {
    const imported = checker.getAliasedSymbol(symbol);
    if (names.includes(imported.getName())) return imported.getName();
  }
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (
      isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & NodeFlags.Const) !== 0
    )
      return checkedCallee(checker, declaration.initializer, names, seen);
    if (
      isBindingElement(declaration) &&
      isObjectBindingPattern(declaration.parent) &&
      isVariableDeclaration(declaration.parent.parent) &&
      isVariableDeclarationList(declaration.parent.parent.parent) &&
      (declaration.parent.parent.parent.flags & NodeFlags.Const) !== 0
    ) {
      const property = declaration.propertyName ?? declaration.name;
      if (!isIdentifier(property)) continue;
      const original = checker.getPropertyOfType(checker.getTypeAtLocation(declaration.parent), property.text);
      if (original !== undefined && names.includes(original.getName())) return original.getName();
    }
  }
  return undefined;
}

/**
 * Whether the nearest condition about the subject checks it by kind. No enclosing
 * condition is distinct from an explicit blind guard: a directly constructed failure is precise.
 */
function guardedByKind(
  call: TSESTree.CallExpression,
  mentions: (test: TSESTree.Expression) => boolean,
  checksKind: (test: TSESTree.Expression) => boolean,
): boolean | undefined {
  let child: TSESTree.Node = call;
  for (let node: TSESTree.Node | undefined = call.parent; node !== undefined; child = node, node = node.parent) {
    if (
      node.type === AST_NODE_TYPES.FunctionDeclaration ||
      node.type === AST_NODE_TYPES.FunctionExpression ||
      node.type === AST_NODE_TYPES.ArrowFunctionExpression
    )
      return undefined;
    if (node.type === AST_NODE_TYPES.BlockStatement) {
      const statements: readonly TSESTree.Node[] = node.body;
      const position = statements.indexOf(child);
      for (let index = position - 1; index >= 0; index -= 1) {
        const preceding = node.body[index];
        if (
          preceding?.type === AST_NODE_TYPES.IfStatement &&
          preceding.alternate === null &&
          exitsFunction(preceding.consequent) &&
          preceding.test.type === AST_NODE_TYPES.UnaryExpression &&
          preceding.test.operator === '!' &&
          mentions(preceding.test.argument)
        )
          return checksKind(preceding.test.argument);
      }
    }
    const test =
      (node.type === AST_NODE_TYPES.IfStatement || node.type === AST_NODE_TYPES.ConditionalExpression) &&
      node.consequent === child
        ? node.test
        : node.type === AST_NODE_TYPES.LogicalExpression && node.operator === '&&' && node.right === child
          ? node.left
          : undefined;
    if (test === undefined) continue;
    if (mentions(test)) return checksKind(test);
  }
  return undefined;
}

/** Only a direct return/throw, possibly in a block, proves this preceding guard's other path exits. */
function exitsFunction(statement: TSESTree.Statement): boolean {
  if (statement.type === AST_NODE_TYPES.ReturnStatement || statement.type === AST_NODE_TYPES.ThrowStatement)
    return true;
  const last = statement.type === AST_NODE_TYPES.BlockStatement ? statement.body.at(-1) : undefined;
  return last !== undefined && exitsFunction(last);
}

/** Const aliases name the same checked value; mutable assignments need separate flow analysis. */
function subjectSymbol(checker: TypeChecker, node: Node, seen = new Set<TypeSymbol>()): TypeSymbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined || seen.has(symbol)) return symbol;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (
    declaration !== undefined &&
    isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    isIdentifier(declaration.initializer) &&
    isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & NodeFlags.Const) !== 0
  )
    return subjectSymbol(checker, declaration.initializer, seen);
  return symbol;
}

function mentionsSubject(checker: TypeChecker, node: Node, subject: TypeSymbol): boolean {
  return (
    (isIdentifier(node) && subjectSymbol(checker, node) === subject) ||
    forEachChild(node, child => (mentionsSubject(checker, child, subject) ? true : undefined)) === true
  );
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
