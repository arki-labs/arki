import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, InvalidEnvelope, isFailure } from '@arki/failure';
import { errorMap, orThrowRpc, reviveRpcError } from '@arki/failure/orpc';

import { action, ACTION_FAILURES } from '../action.js';
import { bindAction } from '../execute.js';

const Missing = defineFailure('catalog.missing', { status: 404, data: z.object({ id: z.string() }) });
const lookupInput = z.object({ id: z.string() });
const item = z.object({ id: z.string(), title: z.string() });
const policy = { exposure: ['rpc'], principal: 'optional', approval: 'none', retry: 'never' } as const;
const invocation = { binding: 'rpc', principal: 'anonymous', approval: 'absent' } as const;
const find = (id: string) => (id === 'missing' ? Missing({ id }) : { id, title: 'Typed systems' });

// A: the reusable descriptor is the source for the transport's schemas/errors.
const reusable = action({ id: 'catalog.lookup', input: lookupInput, output: item, failures: [Missing], policy });
const reusableRpc = oc
  .input(reusable.input)
  .output(reusable.output)
  .errors(errorMap(...reusable.failures));
const boundReusable = bindAction(reusable, input => find(input.id));
const reusableProcedure = implement(reusableRpc).handler(({ input, errors }) =>
  orThrowRpc(boundReusable.handle(input, invocation), errors),
);

// B: a native adapter contract chooses its own schemas, then enters the same owner.
const independentFailures = [Missing, ...ACTION_FAILURES] as const;
const independentRpc = oc
  .input(lookupInput)
  .output(item)
  .errors(errorMap(...independentFailures));
const inputSchema = independentRpc['~orpc'].inputSchema;
const outputSchema = independentRpc['~orpc'].outputSchema;
if (inputSchema === undefined || outputSchema === undefined) throw new Error('Fixture requires schemas');
const independent = {
  id: 'catalog.lookup',
  input: inputSchema,
  output: outputSchema,
  failures: independentFailures,
  policy,
};
const boundIndependent = bindAction(independent, input => find(input.id));
const independentProcedure = implement(independentRpc).handler(({ input, errors }) =>
  orThrowRpc(boundIndependent.handle(input, invocation), errors),
);
const client = createRouterClient({ reusable: reusableProcedure, independent: independentProcedure });

describe('A and B preserve native RPC semantics', () => {
  it('agree on successful values and declared failures', async () => {
    expect(await client.reusable({ id: 'book' })).toEqual(await client.independent({ id: 'book' }));
    for (const call of [client.reusable, client.independent]) {
      const result = await call({ id: 'missing' }).catch((error: unknown) => reviveRpcError(error, reusable.failures));
      expect(result).toEqual(Missing({ id: 'missing' }));
    }
  });

  it('transforms each schema once at the boundary that owns validation', async () => {
    const transformations: string[] = [];
    const descriptor = action({
      id: 'catalog.format',
      input: z.string().transform(value => {
        transformations.push('input');
        return value.length;
      }),
      output: z.number().transform(value => {
        transformations.push('output');
        return `length:${value}`;
      }),
      failures: [],
      policy,
    });
    const bound = bindAction(descriptor, input => input);
    const contract = oc
      .input(descriptor.input)
      .output(descriptor.output)
      .errors(errorMap(...descriptor.failures));
    const procedure = implement(contract).handler(({ input, errors }) =>
      orThrowRpc(bound.handle(input, invocation), errors),
    );
    const native = createRouterClient({ format: procedure });
    expect(await bound.run('book', invocation)).toBe('length:4');
    expect(transformations).toEqual(['input', 'output']);
    transformations.length = 0;
    expect(await native.format('book')).toBe('length:4');
    expect(transformations).toEqual(['input', 'output']);
  });

  it('allows an intentionally different AI search input/output while composing the same usecase', async () => {
    const search = action({
      id: 'catalog.search',
      input: z.object({ query: z.string().min(1) }),
      output: z.object({ matches: z.array(item), explanation: z.string() }),
      failures: [Missing],
      policy: { ...policy, exposure: ['ai'] },
    });
    const bound = bindAction(search, input => {
      const found = find(input.query);
      if (isFailure(found)) return found;
      return { matches: [found], explanation: 'Exact catalog match' };
    });
    expect(await bound.run({ query: 'book' }, { ...invocation, binding: 'ai' })).toEqual({
      matches: [{ id: 'book', title: 'Typed systems' }],
      explanation: 'Exact catalog match',
    });
  });

  it('returns a protocol refusal for an unknown RPC code or malformed known payload', async () => {
    const { ORPCError } = await import('@orpc/client');
    expect(reviveRpcError(new ORPCError('not.registered'), reusable.failures)).toMatchObject({
      code: InvalidEnvelope.code,
      data: { reason: 'unknown_code' },
    });
    expect(reviveRpcError(new ORPCError(Missing.code, { data: { id: 42 } }), reusable.failures)).toMatchObject({
      code: InvalidEnvelope.code,
      data: { reason: 'invalid_data' },
    });
  });
});
