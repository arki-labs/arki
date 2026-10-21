import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { action, ACTION_FAILURES } from '@arki/dot/action';
import { bindAction } from '@arki/dot/execute';
import { defineFailure } from '@arki/failure';

import { routes } from '../bundle.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { buildEngine } from '../compiled.js';
import { codec } from '../wire.js';

const Missing = defineFailure('catalog.missing', { status: 404, data: z.object({ id: z.string() }) });
const item = z.object({ id: z.string(), title: z.string() });
const lookupInput = z.object({ id: z.string() });
const policy = { exposure: ['http'], principal: 'optional', approval: 'none', retry: 'never' } as const;
const invocation = { binding: 'http', principal: 'anonymous', approval: 'absent' } as const;
const find = (id: string) => (id === 'missing' ? Missing({ id }) : { id, title: 'Typed systems' });
const reusable = action({ id: 'catalog.lookup', input: lookupInput, output: item, failures: [Missing], policy });
const boundReusable = bindAction(reusable, input => find(input.id));
const routeA = route.post('/lookup-a', {
  id: 'catalog.a',
  body: reusable.input,
  output: reusable.output,
  failures: reusable.failures,
});

// B independently selects its public HTTP contract. Shared schemas are referenced, never restated.
const routeB = route.get('/lookup-b/:id', { id: 'catalog.b', output: item, failures: [Missing, ...ACTION_FAILURES] });
const boundIndependent = bindAction(
  { id: routeB.id, input: lookupInput, output: routeB.output, failures: routeB.failures, policy },
  input => find(input.id),
);
expectTypeOf<Awaited<ReturnType<typeof boundReusable.run>>>().not.toBeAny();
expectTypeOf<Awaited<ReturnType<typeof boundIndependent.run>>>().not.toBeUnknown();
const engine = buildEngine([
  routes()
    .bind(routeA, ({ body }) => boundReusable.handle(body, invocation))
    .bind(routeB, ({ params }) => boundIndependent.handle(params, invocation)),
]);
const client = createClient(
  { a: routeA, b: routeB },
  {
    baseUrl: 'http://catalog.test',
    fetch: (url, init) => engine.fetch(new Request(url, init)),
  },
);

describe('action and independent HTTP boundaries', () => {
  it('keep HTTP addressing differences while sharing execution and outcomes', async () => {
    for (const id of ['book', 'missing']) {
      expect(await client.a({ body: { id } })).toEqual(await client.b({ params: { id } }));
    }
  });
  it('keeps the declared status and JSON failure data through the native fetch engine', async () => {
    const response = await engine.fetch(new Request('http://catalog.test/lookup-b/missing'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: Missing.code, data: { id: 'missing' } } });
  });

  it('parses HTTP input once and leaves wire encoding to the native codec', async () => {
    const transformations: string[] = [];
    const descriptor = action({
      id: 'catalog.length',
      input: z.string().transform(value => {
        transformations.push('input');
        return value.length;
      }),
      output: z.number(),
      failures: [],
      policy,
    });
    const bound = bindAction(descriptor, input => input);
    const nativeOutput = codec(
      z.string().transform(Number),
      z.number().transform(value => {
        transformations.push('output');
        return String(value);
      }),
    );
    const contract = route.post('/length', {
      id: descriptor.id,
      body: descriptor.input,
      output: nativeOutput,
      failures: descriptor.failures,
    });
    const native = buildEngine([routes().bind(contract, ({ body }) => bound.handle(body, invocation))]);
    const response = await native.fetch(
      new Request('http://catalog.test/length', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('book'),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBe('4');
    expect(transformations).toEqual(['input', 'output']);
  });
});
