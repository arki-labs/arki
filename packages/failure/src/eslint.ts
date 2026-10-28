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
  isArrayLiteralExpression,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSpreadElement,
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
    const checkedValues = new Set<TSESTree.Expression>();
    const checkDiscarded = (expressions: TSESTree.Expression[], node: TSESTree.Node): void => {
      const values = expressions
        .flatMap(expression => discardedValues(expression))
        .filter(value => !checkedValues.has(value));
      for (const value of values) checkedValues.add(value);
      const codes = new Set(
        values.flatMap(value =>
          resultTypes(checker, services.getTypeAtLocation(value)).flatMap(part => failureCodes(checker, part)),
        ),
      );
      if (codes.size > 0) context.report({ node, messageId: 'mustUse', data: { codes: [...codes].join(', ') } });
    };
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
      ReturnStatement(node) {
        if (node.argument !== null) checkCallback(node.argument);
      },
      PropertyDefinition(node) {
        if (node.value !== null) checkCallback(node.value);
      },
      Property(node) {
        if (node.value.type === AST_NODE_TYPES.Identifier || node.value.type === AST_NODE_TYPES.MemberExpression)
          checkCallback(node.value);
      },
      ExpressionStatement(node) {
        checkDiscarded([node.expression], node);
      },
      UnaryExpression(node) {
        if (node.operator === 'void') checkDiscarded([node.argument], node);
      },
      SequenceExpression(node) {
        checkDiscarded(node.expressions.slice(0, -1), node);
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

    /** Exact checked codes must also cover the current compiler flow type, not stale guard syntax. */
    const checkedKinds = (
      test: TSESTree.Expression,
      subjects: readonly Reference[],
      truthy = true,
    ): ReadonlySet<string> | undefined => {
      if (test.type === AST_NODE_TYPES.UnaryExpression && test.operator === '!')
        return checkedKinds(test.argument, subjects, !truthy);
      if (test.type === AST_NODE_TYPES.LogicalExpression) {
        const left = checkedKinds(test.left, subjects, truthy);
        const right = checkedKinds(test.right, subjects, truthy);
        if ((test.operator === '||' && truthy) || (test.operator === '&&' && !truthy))
          return left === undefined || right === undefined ? undefined : new Set([...left, ...right]);
        if ((test.operator === '&&' && truthy) || (test.operator === '||' && !truthy)) {
          if (left === undefined) return right;
          if (right === undefined) return left;
          return new Set([...left].filter(code => right.has(code)));
        }
      }
      if (
        test.type === AST_NODE_TYPES.BinaryExpression &&
        ((test.operator === '===' && truthy) || (test.operator === '!==' && !truthy))
      ) {
        const codeAccess = (expression: TSESTree.Expression): boolean =>
          expression.type === AST_NODE_TYPES.MemberExpression &&
          referenceMatches(checker, services.esTreeNodeToTSNodeMap.get(expression.object), subjects) &&
          ((!expression.computed &&
            expression.property.type === AST_NODE_TYPES.Identifier &&
            expression.property.name === 'code') ||
            (expression.computed &&
              expression.property.type === AST_NODE_TYPES.Literal &&
              expression.property.value === 'code'));
        const right = services.getTypeAtLocation(test.right);
        if (codeAccess(test.left) && right.isStringLiteral()) return new Set([right.value]);
        const left = services.getTypeAtLocation(test.left);
        if (codeAccess(test.right) && left.isStringLiteral()) return new Set([left.value]);
      }
      if (test.type !== AST_NODE_TYPES.CallExpression || !truthy) return undefined;
      const signature = checker.getResolvedSignature(services.esTreeNodeToTSNodeMap.get(test));
      // Generic guards name no kind, even when their current argument has one refusal.
      if (signature === undefined || (signature.getDeclaration().typeParameters?.length ?? 0) > 0) return undefined;
      const predicate = checker.getTypePredicateOfSignature(signature);
      if (predicate?.type === undefined || predicate.parameterIndex === undefined) return undefined;
      const argument = test.arguments[predicate.parameterIndex];
      if (
        argument === undefined ||
        argument.type === AST_NODE_TYPES.SpreadElement ||
        !referenceMatches(checker, services.esTreeNodeToTSNodeMap.get(argument), subjects)
      )
        return undefined;
      const narrowed = kinds(checker, predicate.type);
      return narrowed.codes.size === 1 && !narrowed.wide && !narrowed.plain ? narrowed.codes : undefined;
    };

    return {
      CallExpression(node) {
        const callee = services.esTreeNodeToTSNodeMap.get(node.callee);
        const applyReceiver = callableReceiver(checker, callee, 'apply');
        const receiver =
          applyReceiver ?? callableReceiver(checker, callee, 'call') ?? callableReceiver(checker, callee, 'bind');
        const name = checkedCallee(checker, receiver ?? callee, names);
        if (name === undefined) return;
        const argument = node.arguments[receiver === undefined ? 0 : 1];
        if (argument === undefined || argument.type === AST_NODE_TYPES.SpreadElement) return;
        let type: Type = services.getTypeAtLocation(argument);
        const argumentNode = services.esTreeNodeToTSNodeMap.get(argument);
        let subjects = references(checker, argumentNode);
        if (applyReceiver !== undefined) {
          if (argument.type === AST_NODE_TYPES.ArrayExpression) {
            const first = argument.elements[0];
            if (first === undefined || first === null || first.type === AST_NODE_TYPES.SpreadElement) return;
            type = services.getTypeAtLocation(first);
            subjects = references(checker, services.esTreeNodeToTSNodeMap.get(first));
          } else {
            if (!checker.isTupleType(type)) return;
            const first = type.getProperty('0');
            if (first === undefined) return;
            type = checker.getTypeOfSymbol(first);
            subjects = subjects.map(subject => ({ ...subject, keys: [...subject.keys, '0'] }));
            const origin = tupleFirstValue(checker, argumentNode);
            // A mutable union slot may have changed since capture; only a single declared kind keeps that proof.
            const captured = kinds(checker, type);
            if (origin !== undefined && captured.codes.size === 1 && !captured.wide && !captured.plain)
              subjects.push(...references(checker, origin));
          }
        }
        const found = kinds(checker, type);
        // Not a failure at all (such as `dialog.accept('yes')`): another API's `accept`.
        if (found.codes.size === 0 && !found.wide) return;
        const guard = guardedByKind(
          node,
          test => mentionsSubject(checker, services.esTreeNodeToTSNodeMap.get(test), subjects),
          (test, truthy) => {
            const checked = checkedKinds(test, subjects, truthy);
            return checked !== undefined && !found.wide && [...found.codes].every(code => checked.has(code));
          },
        );
        const blind =
          found.plain || (found.wide && guard !== true) || guard === false || (found.codes.size > 1 && guard !== true);
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
  if (isCallExpression(callee) && callee.arguments.length === 1) {
    const receiver = callableReceiver(checker, callee.expression, 'bind');
    if (receiver !== undefined) return checkedCallee(checker, receiver, names, seen);
  }
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

/** Function protocol methods keep the original call target; arbitrary object properties do not. */
function callableReceiver(checker: TypeChecker, callee: Node, method: string): Node | undefined {
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const name = isPropertyAccessExpression(callee)
    ? callee.name.text
    : (() => {
        const key = checker.getTypeAtLocation(callee.argumentExpression);
        return key.isStringLiteral() ? key.value : undefined;
      })();
  return name === method && checker.getTypeAtLocation(callee.expression).getCallSignatures().length > 0
    ? callee.expression
    : undefined;
}

/**
 * Whether the nearest condition about the subject checks it by kind. No enclosing
 * condition is distinct from an explicit blind guard: a directly constructed failure is precise.
 */
function guardedByKind(
  call: TSESTree.CallExpression,
  mentions: (test: TSESTree.Expression) => boolean,
  checksKind: (test: TSESTree.Expression, truthy: boolean) => boolean,
): boolean | undefined {
  let child: TSESTree.Node = call;
  for (let node = call.parent; node.type !== AST_NODE_TYPES.Program; child = node, node = node.parent) {
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
          mentions(preceding.test)
        )
          return checksKind(preceding.test, false);
      }
    }
    if (
      (node.type === AST_NODE_TYPES.IfStatement || node.type === AST_NODE_TYPES.ConditionalExpression) &&
      (node.consequent === child || node.alternate === child) &&
      mentions(node.test)
    )
      return checksKind(node.test, node.consequent === child);
    if (
      node.type === AST_NODE_TYPES.LogicalExpression &&
      (node.operator === '&&' || node.operator === '||') &&
      node.right === child &&
      mentions(node.left)
    )
      return checksKind(node.left, node.operator === '&&');
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

/** A tuple literal or variable initializer supplies provenance, used only for a single declared kind. */
function tupleFirstValue(checker: TypeChecker, node: Node, seen = new Set<TypeSymbol>()): Node | undefined {
  if (isAsExpression(node) || isSatisfiesExpression(node) || isParenthesizedExpression(node))
    return tupleFirstValue(checker, node.expression, seen);
  if (isArrayLiteralExpression(node)) {
    const first = node.elements[0];
    return first !== undefined && !isSpreadElement(first) ? first : undefined;
  }
  if (!isIdentifier(node)) return undefined;
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !isVariableDeclarationList(declaration.parent)
  )
    return undefined;
  return tupleFirstValue(checker, declaration.initializer, seen);
}

/** Reference paths retain symbol identity and literal keys, without evaluating values or synthesizing AST nodes. */
function referencePath(checker: TypeChecker, node: Node) {
  let current = node;
  const keys: string[] = [];
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    const key = isPropertyAccessExpression(current)
      ? current.name.text
      : (() => {
          if (isNumericLiteral(current.argumentExpression)) return current.argumentExpression.text;
          const type = checker.getTypeAtLocation(current.argumentExpression);
          return type.isStringLiteral() || type.isNumberLiteral() ? String(type.value) : undefined;
        })();
    if (key === undefined) return;
    keys.unshift(key);
    current = current.expression;
  }
  if (!isIdentifier(current)) return;
  const root = subjectSymbol(checker, current);
  return root === undefined ? undefined : { root, keys };
}

type Reference = NonNullable<ReturnType<typeof referencePath>>;

function references(checker: TypeChecker, node: Node): Reference[] {
  const reference = referencePath(checker, node);
  return reference === undefined ? [] : [reference];
}

function referenceMatches(checker: TypeChecker, node: Node, subjects: readonly Reference[]): boolean {
  const found = referencePath(checker, node);
  return (
    found !== undefined &&
    subjects.some(
      subject =>
        found.root === subject.root &&
        found.keys.length === subject.keys.length &&
        found.keys.every((key, index) => key === subject.keys[index]),
    )
  );
}

function mentionsSubject(checker: TypeChecker, node: Node, subjects: readonly Reference[]): boolean {
  return (
    referenceMatches(checker, node, subjects) ||
    forEachChild(node, child => (mentionsSubject(checker, child, subjects) ? true : undefined)) === true
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
