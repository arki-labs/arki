/**
 * `@arki/expr`: a safe expression language on `@arki/math`. This entry parses
 * and prints; it holds no numeric code. Evaluation lives in the domain
 * entries.
 */
export type {
  BinaryNode,
  BinaryOperator,
  CallNode,
  CallNotation,
  Equation,
  Expr,
  FactorialNode,
  GroupNode,
  NameNode,
  Node,
  NumberNode,
  UnaryNode,
  Warning,
  WarningCode,
} from './ast.js';
export { children, walk } from './ast.js';
export type { Budget, ParseErrorCode, ParseFailure, Span } from './errors.js';
export { ExprLimitError, ParseError } from './errors.js';
export type { FromJSONOptions } from './json.js';
export { fromJSON } from './json.js';
export type {
  ConstantDefinition,
  ConstantSpec,
  FunctionDefinition,
  FunctionSpec,
  Language,
  LanguageDefinition,
} from './language.js';
export { defineLanguage, scientific } from './language.js';
export type { Limits } from './limits.js';
export type { Names } from './names.js';
export { names } from './names.js';
export type { ParseOptions } from './parser.js';
export { parse, parseEquation } from './parser.js';
export type { PrintOptions, PrintStyle } from './print.js';
export { print } from './print.js';
export type { Syntax, SyntaxDefinition } from './syntax.js';
export { canonical, decimalComma, defineSyntax, syntaxFor } from './syntax.js';
