/**
 * The AST (RFC §6): plain, JSON-serializable objects discriminated on `kind`.
 * Every node carries the span of the text it came from. Literal text is kept
 * (`raw`) so each numeric domain reads it with its own constructor; groups and
 * call notation are kept so printing is faithful to what the user typed.
 */
import type { Span } from './errors.js';

export type NumberNode = {
  readonly kind: 'number';
  /** The literal with a `.` decimal mark, exactly as typed otherwise: `'0.50'`, `'1e-7'`, `'.5'`. */
  readonly raw: string;
  readonly span: Span;
};

/** A variable or constant, as typed. Multi-letter names are never split here (that is `compile`'s job). */
export type NameNode = { readonly kind: 'name'; readonly name: string; readonly span: Span };

export type UnaryNode = { readonly kind: 'unary'; readonly op: '-' | '+'; readonly arg: Node; readonly span: Span };

export type BinaryOperator = '+' | '-' | '*' | '/' | '^';

export type BinaryNode = {
  readonly kind: 'binary';
  readonly op: BinaryOperator;
  readonly left: Node;
  readonly right: Node;
  /** True for juxtaposition (`2x`); only ever true with `op: '*'`. */
  readonly implicit: boolean;
  readonly span: Span;
};

/** How a call was written: `abs(x)` is `'call'`, `|x|` is `'bars'` (fn `abs`), `√x` is `'radical'` (fn `sqrt`). */
export type CallNotation = 'call' | 'bars' | 'radical';

export type CallNode = {
  readonly kind: 'call';
  readonly fn: string;
  readonly args: readonly Node[];
  readonly notation: CallNotation;
  readonly span: Span;
};

export type FactorialNode = { readonly kind: 'factorial'; readonly arg: Node; readonly span: Span };

/** Parentheses the user wrote. */
export type GroupNode = { readonly kind: 'group'; readonly inner: Node; readonly span: Span };

export type Node = NumberNode | NameNode | UnaryNode | BinaryNode | CallNode | FactorialNode | GroupNode;

/**
 * `implicit-after-division` and `implicit-after-power` come from `parse`;
 * `split-after-division` comes from `compile`, which reads `a/bc` as `a/(b·c)`
 * when it splits `bc` into letters.
 */
export type WarningCode = 'implicit-after-division' | 'implicit-after-power' | 'split-after-division';

/** A legal but easily misread input, such as `1/2x` (read as `(1/2)·x`). */
export type Warning = {
  readonly code: WarningCode;
  readonly span: Span;
  readonly message: string;
  /** What to write instead, built from the source, e.g. `write (1/2)x or 1/(2x)`. */
  readonly hint: string;
};

export type Expr = {
  readonly version: 1;
  readonly source: string;
  readonly root: Node;
  readonly warnings: readonly Warning[];
};

export type Equation = {
  readonly version: 1;
  readonly source: string;
  readonly left: Node;
  readonly right: Node;
  readonly warnings: readonly Warning[];
};

/** The direct children of a node, left to right. */
export function children(node: Node): readonly Node[] {
  switch (node.kind) {
    case 'number':
    case 'name': {
      return [];
    }
    case 'unary':
    case 'factorial': {
      return [node.arg];
    }
    case 'binary': {
      return [node.left, node.right];
    }
    case 'call': {
      return [...node.args];
    }
    case 'group': {
      return [node.inner];
    }
  }
}

/**
 * Visits `node` and its descendants in pre-order (parents first, children left
 * to right). Return `false` from `visit` to skip a node's children. Iterative,
 * so it never overflows the stack, whatever the depth.
 */
export function walk(node: Node, visit: (node: Node, parent: Node | undefined) => boolean | void): void {
  const stack: [Node, Node | undefined][] = [[node, undefined]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [current, parent] = item;
    if (visit(current, parent) === false) continue;
    const kids = children(current);
    for (let index = kids.length - 1; index >= 0; index--) {
      const kid = kids[index];
      if (kid !== undefined) stack.push([kid, current]);
    }
  }
}
