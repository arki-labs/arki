import { generateText, Output } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { type } from 'arktype';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { InvalidInput, UnexpectedFailure } from '@arki/failure';
import { hasJsonSchema, withJsonSchema } from '@arki/schema';

import { ConfigurationError } from '../errors';
import { modelSchema } from './model-schema';

// The model writes a string; the caller wants its length. Input type differs from output type.
const lengthJson = { type: 'object', properties: { n: { type: 'string' } }, required: ['n'] };
const handWritten = withJsonSchema<{ n: string }, { n: number }>(
  {
    '~standard': {
      version: 1,
      vendor: 'hand',
      validate: value =>
        typeof value === 'object' && value !== null && 'n' in value && typeof value.n === 'string'
          ? { value: { n: value.n.length } }
          : { issues: [{ message: 'n must be a string', path: [{ key: 'n' }] }] },
    },
  },
  lengthJson,
);
const zodSchema = z.object({ n: z.string().transform(s => s.length) });
const valibotSchema = withJsonSchema(
  v.object({
    n: v.pipe(
      v.string(),
      v.transform(s => s.length),
    ),
  }),
  lengthJson,
);
const arkSchema = type({ n: 'string' }).pipe(({ n }) => ({ n: n.length }));

const finish = { unified: 'stop', raw: 'stop' } as const;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function modelAnswering(text: string) {
  return new MockLanguageModelV4({
    doGenerate: () => Promise.resolve({ content: [{ type: 'text', text }], finishReason: finish, usage, warnings: [] }),
  });
}

async function generate<S extends StandardSchemaV1>(schema: S, text: string): Promise<SchemaOutput<S>> {
  const { output } = await generateText({
    model: modelAnswering(text),
    prompt: 'go',
    output: Output.object({ schema: modelSchema(schema, 'test') }),
  });
  return output;
}

describe('modelSchema: the model writes the INPUT shape, the caller gets the OUTPUT shape', () => {
  it.each([
    ['hand-written', handWritten],
    ['zod', zodSchema],
    ['valibot', valibotSchema],
    ['arktype', arkSchema],
  ] as const)('%s: a transforming schema returns the transformed value', async (_name, schema) => {
    // WHY: if the provider were shown the OUTPUT shape, the model would write a number and the
    // transform would never run on the string the schema's input type promises.
    expect(await generate(schema, '{"n":"abcd"}')).toEqual({ n: 4 });
  });

  it('shows the model the input JSON Schema, not the output one', () => {
    const shown = modelSchema(zodSchema, 'test').jsonSchema;
    expect(shown).toMatchObject({ properties: { n: { type: 'string' } } });
  });

  it('types the result by the schema output', async () => {
    const out: { n: number } = await generate(zodSchema, '{"n":"ab"}');
    expect(out.n).toBe(2);
  });

  it('reports bad model output with canonical input issues and the issue path', async () => {
    // WHY: the app needs `issues` to retry or show what the model got wrong.
    const failure = await generate(handWritten, '{"n":5}').catch((error: unknown) => error);
    // The SDK wraps our error (NoObjectGeneratedError > TypeValidationError); walk down to it.
    let found: unknown = failure;
    while (found instanceof Error && !(found instanceof UnexpectedFailure)) found = found.cause;
    const issues =
      found instanceof UnexpectedFailure && InvalidInput.is(found.failure) ? found.failure.data.issues : [];
    expect(issues.map(issue => issue.path)).toEqual([['n']]);
  });
});

describe('modelSchema: a schema with no JSON Schema is a loud error', () => {
  it('names the call site and withJsonSchema, never sends an empty schema', () => {
    const bare = v.object({ n: v.string() });
    expect(hasJsonSchema(bare)).toBe(false);
    expect(() => modelSchema(bare, 'tool "weather"')).toThrow(ConfigurationError);
    expect(() => modelSchema(bare, 'tool "weather"')).toThrow(/tool "weather".*withJsonSchema/);
  });

  it('names the call site when the conversion throws', () => {
    const broken = withJsonSchema(zodSchema, lengthJson);
    const throwing: typeof broken = {
      '~standard': {
        ...broken['~standard'],
        jsonSchema: {
          input: () => {
            throw new Error('cannot convert');
          },
          output: () => lengthJson,
        },
      },
    };
    expect(() => modelSchema(throwing, 'OpenAI structured generation')).toThrow(
      /OpenAI structured generation.*cannot convert.*withJsonSchema/,
    );
  });
});
