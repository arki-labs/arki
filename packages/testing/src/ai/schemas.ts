/**
 * The two answer shapes the judge is asked for, as Standard Schemas that also describe themselves
 * as JSON Schema (Ollama constrains its output with it). Hand-written so the package needs no
 * schema library of its own.
 */
import type { SchemaWithJson } from '@arki/schema';
import { is, recordSchema, withJsonSchema } from '@arki/schema';

type Failure = { readonly issues: readonly { readonly message: string }[] };

function schemaOf<TOutput>(
  json: Readonly<Record<string, unknown>>,
  read: (value: unknown) => TOutput | null,
  shape: string,
): SchemaWithJson<unknown, TOutput> {
  const validator = {
    '~standard': {
      version: 1 as const,
      vendor: 'arki-testing',
      validate(value: unknown): { readonly value: TOutput } | Failure {
        const checked = read(value);
        return checked === null ? { issues: [{ message: `expected ${shape}` }] } : { value: checked };
      },
    },
  };
  return withJsonSchema(validator, json);
}

export type Verdict = { readonly pass: boolean; readonly reason: string };

export const verdictSchema = schemaOf<Verdict>(
  {
    type: 'object',
    properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['pass', 'reason'],
  },
  value =>
    is(value, recordSchema) && typeof value['pass'] === 'boolean' && typeof value['reason'] === 'string'
      ? { pass: value['pass'], reason: value['reason'] }
      : null,
  '{ pass: boolean, reason: string }',
);

export type CheckedClaim = { readonly claim: string; readonly supported: boolean; readonly quote: string };

export const claimsSchema = schemaOf<{ readonly claims: readonly CheckedClaim[] }>(
  {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: { claim: { type: 'string' }, supported: { type: 'boolean' }, quote: { type: 'string' } },
          required: ['claim', 'supported', 'quote'],
        },
      },
    },
    required: ['claims'],
  },
  value => {
    if (!is(value, recordSchema) || !Array.isArray(value['claims'])) return null;
    const claims: CheckedClaim[] = [];
    const items: readonly unknown[] = value['claims'];
    for (const item of items) {
      if (
        !is(item, recordSchema) ||
        typeof item['claim'] !== 'string' ||
        typeof item['supported'] !== 'boolean' ||
        typeof item['quote'] !== 'string'
      )
        return null;
      claims.push({ claim: item['claim'], supported: item['supported'], quote: item['quote'] });
    }
    return { claims };
  },
  '{ claims: { claim: string, supported: boolean, quote: string }[] }',
);
