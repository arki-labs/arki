// The zero-cost check of RFC §9.2: `derivative` against a build of the
// differentiator with the step recorder deleted. This file writes that build:
// `dist/differentiate.js` with every recording branch removed, and
// `dist/derivative.js` pointed at it, into `.bench/no-recorder/` (outside the
// published dist). It throws when the source no longer has the shape it
// removes, so a changed recorder cannot silently make the check meaningless.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const DIST = new URL('../dist/', import.meta.url);
const OUT = new URL('../.bench/no-recorder/', import.meta.url);
/** The lists steps are recorded into: `derive`'s `into` and a rule body's `kids`. */
const LISTS = new Set(['into', 'kids']);

type Counts = { push: number; fill: number; build: number; children: number };

function named(node: ts.Node, names: ReadonlySet<string>): boolean {
  return ts.isIdentifier(node) && names.has(node.text);
}

function strict(node: ts.Expression, operator: ts.SyntaxKind, names: ReadonlySet<string>): boolean {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === operator &&
    named(node.left, names) &&
    ts.isIdentifier(node.right) &&
    node.right.text === 'undefined'
  );
}

function stripRecorder(counts: Counts): ts.TransformerFactory<ts.SourceFile> {
  return context => {
    const visit = (node: ts.Node): ts.VisitResult<ts.Node | undefined> => {
      // `into?.push(step)` and `kids?.push(step)`: record a step.
      if (
        ts.isExpressionStatement(node) &&
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        named(node.expression.expression.expression, LISTS)
      ) {
        counts.push++;
        return undefined;
      }
      // `if (step !== undefined) …`: fill in a recorded step.
      if (
        ts.isIfStatement(node) &&
        strict(node.expression, ts.SyntaxKind.ExclamationEqualsEqualsToken, new Set(['step']))
      ) {
        counts.fill++;
        return undefined;
      }
      // `into === undefined ? undefined : { … }`: build a step.
      if (ts.isConditionalExpression(node) && strict(node.condition, ts.SyntaxKind.EqualsEqualsEqualsToken, LISTS)) {
        counts.build++;
        return ts.visitNode(node.whenTrue, visit);
      }
      // `step?.children`: the list a recorded step's children go into.
      if (
        ts.isPropertyAccessExpression(node) &&
        node.questionDotToken !== undefined &&
        named(node.expression, new Set(['step'])) &&
        node.name.text === 'children'
      ) {
        counts.children++;
        return context.factory.createIdentifier('undefined');
      }
      return ts.visitEachChild(node, visit, context);
    };
    return file => ts.visitEachChild(file, visit, context);
  };
}

/** Relative imports point at the built package, except the ones in `redirect`. */
function relink(code: string, redirect: Readonly<Record<string, URL>>): string {
  return code.replaceAll(/from (["'])\.\/([\w.-]+)\1/gu, (_, quote: string, file: string) => {
    const target = redirect[file] ?? new URL(file, DIST);
    return `from ${quote}${target.href}${quote}`;
  });
}

function transform(file: string, transformers: ts.TransformerFactory<ts.SourceFile>[]): string {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, DIST), 'utf8'), ts.ScriptTarget.Latest, true);
  const result = ts.transform(source, transformers);
  const [output] = result.transformed;
  if (output === undefined) throw new Error(`no output for ${file}`);
  const code = ts.createPrinter().printFile(output);
  result.dispose();
  return code;
}

/** Writes the build and returns the URL of its `derivative.js`. */
export function buildNoRecorder(): URL {
  const counts: Counts = { push: 0, fill: 0, build: 0, children: 0 };
  const differentiate = transform('differentiate.js', [stripRecorder(counts)]);
  for (const [shape, count] of Object.entries(counts)) {
    if (count === 0) throw new Error(`no-recorder build: no '${shape}' site left to remove in dist/differentiate.js`);
  }
  if (/\b(?:into|kids)\?\./u.test(differentiate) || /\binto === undefined/u.test(differentiate)) {
    throw new Error('no-recorder build: a recording branch is left in dist/differentiate.js');
  }
  mkdirSync(OUT, { recursive: true });
  const differentiateUrl = new URL('differentiate.js', OUT);
  const derivativeUrl = new URL('derivative.js', OUT);
  writeFileSync(differentiateUrl, relink(differentiate, {}));
  writeFileSync(derivativeUrl, relink(transform('derivative.js', []), { 'differentiate.js': differentiateUrl }));
  return derivativeUrl;
}
