import type { Paragraph } from 'mdast';

import { z } from '@arki/contracts';

/** `value` checked against `schema`; throws naming `what` and every mismatch when it does not fit. */
export function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${what} does not match the expected shape:\n${z.prettifyError(result.error)}`);
  return result.data;
}

// borrowed from ggoodman/nostalgie
// https://github.com/ggoodman/nostalgie/blob/26a7fad65faefdffe3ea06f0b9892ba3dd5c1efa/src/worker/mdxCompiler.ts
export const createJSONParseAST = (value: string) => {
  return {
    type: 'Program',
    body: [
      {
        type: 'ExpressionStatement',
        expression: {
          type: 'CallExpression',
          callee: {
            type: 'MemberExpression',
            object: {
              type: 'Identifier',
              name: 'JSON',
            },
            property: {
              type: 'Identifier',
              name: 'parse',
            },
            computed: false,
            optional: false,
          },
          arguments: [
            {
              type: 'Literal',
              value: value,
              raw: JSON.stringify(value),
            },
          ],
          optional: false,
        },
      },
    ],
    sourceType: 'module',
    comments: [],
  };
};

/** Turns the paragraph into `<name {...props} />` in place; each prop is passed as JSON. */
export function replaceWithElement(paragraph: Paragraph, name: string, props: Record<string, unknown>): void {
  Object.assign(paragraph, {
    type: 'mdxJsxFlowElement',
    name,
    attributes: Object.entries(props).map(([prop, value]) => ({
      type: 'mdxJsxAttribute',
      name: prop,
      value: {
        type: 'mdxJsxAttributeValueExpression',
        data: { estree: createJSONParseAST(JSON.stringify(value)) },
      },
    })),
    children: [],
    position: {},
  });
}
