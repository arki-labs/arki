import { minifyContractRouter, oc } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OPERATION, operationAt, operationOf, operations } from './orpc.js';

const post = z.object({ id: z.string(), title: z.string() });

const contract = {
  posts: {
    list: oc.input(z.object({ cursor: z.string().optional() })).output(z.array(post)),
    create: oc
      .$meta<{ offlineSafe: true }>({ offlineSafe: true })
      .input(post.omit({ id: true }))
      .output(post),
    comments: { add: oc.input(z.object({ postId: z.string(), body: z.string() })) },
  },
  health: oc.output(z.object({ ok: z.boolean() })),
};

describe('operations', () => {
  it('preserves prototype-shaped keys as own data through enumeration and serialization', () => {
    // Persisted operation identities must not disappear through Object.prototype setters.
    const unusual = { ['__proto__']: { ['__proto__']: oc }, constructor: oc, toString: oc };
    const ops = operations(unusual);
    expect(Object.keys(ops)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.keys(ops.__proto__)).toEqual(['__proto__']);
    expect(ops.__proto__.__proto__.path).toEqual(['__proto__', '__proto__']);
    expect(Object.getPrototypeOf(ops)).toBe(Object.prototype);
    expect(Object.isFrozen(ops.__proto__)).toBe(true);
    expect(JSON.stringify(ops)).toContain('"name":"__proto__.__proto__"');
    expect(operationAt(unusual, ['__proto__', '__proto__'])).toEqual(ops.__proto__.__proto__);
  });

  it('gives every procedure its path, its dotted name (the server stores the same string) and its meta', () => {
    const ops = operations(contract);
    expect(ops.posts.create).toEqual({ path: ['posts', 'create'], name: 'posts.create', meta: { offlineSafe: true } });
    expect(ops.posts.comments.add.name).toBe('posts.comments.add');
    expect(ops.health).toEqual({ path: ['health'], name: 'health', meta: {} });
  });

  it('returns frozen plain data, so an operation can be logged, compared and persisted', () => {
    const op = operations(contract).posts.list;
    expect(Object.isFrozen(op)).toBe(true);
    expect(Object.isFrozen(op.path)).toBe(true);
    expect(JSON.stringify(op)).toBe('{"path":["posts","list"],"name":"posts.list","meta":{}}');
  });

  it('works on a minified contract: the walk needs path and meta only, not the schemas', () => {
    const minified = minifyContractRouter(contract);
    expect(operations(minified)).toEqual(operations(contract));
  });

  it('fails loud, naming the path, on a key with "." (it would make the name ambiguous)', () => {
    expect(() => operations({ posts: { 'by.id': oc.output(post) } })).toThrow(/"by\.id" at posts > by\.id/);
  });

  it.each([
    '~op',
    'key',
    'call',
    'queryKey',
    'queryOptions',
    'infiniteKey',
    'infiniteOptions',
    'mutationKey',
    'mutationOptions',
  ])('fails loud on the reserved key %s (a group utils object would shadow it)', key => {
    expect(() => operations({ posts: { [key]: oc.output(post) } })).toThrow(TypeError);
    expect(() => operations({ posts: { [key]: oc.output(post) } })).toThrow(`at posts > ${key}`);
  });
});

describe('operationAt', () => {
  it('finds the operation at a path', () => {
    expect(operationAt(contract, ['posts', 'create'])).toEqual(operations(contract).posts.create);
  });

  it('is undefined for a missing path or a group', () => {
    expect(operationAt(contract, ['posts', 'missing'])).toBeUndefined();
    expect(operationAt(contract, ['posts'])).toBeUndefined();
  });
});

describe('operationOf', () => {
  it('preserves the operation and metadata identities while reading native accessors once', () => {
    const original = operations(contract).posts.create;
    const reads = { carrier: 0, path: 0, name: 0, meta: 0 };
    const op = {
      get path() {
        reads.path++;
        return original.path;
      },
      get name() {
        reads.name++;
        return original.name;
      },
      get meta() {
        reads.meta++;
        return original.meta;
      },
    };
    const carrier = {
      get [OPERATION]() {
        reads.carrier++;
        return op;
      },
    };
    expect(operationOf(carrier)).toBe(op);
    expect(reads).toEqual({ carrier: 1, path: 1, name: 1, meta: 1 });
    expect(op.meta).toBe(original.meta);
  });

  it('rejects forged paths whose overridden every method would hide invalid segments', () => {
    const path = Object.assign([42], { every: () => true });
    const carrier = { [OPERATION]: { path, name: '42', meta: {} } };
    expect(() => Reflect.apply(operationOf, null, [carrier])).toThrow('ARKI_CONTRACTS_E007');
  });

  it('rejects forged operation names even when a path overrides join', () => {
    const name = {};
    const path = Object.assign(['posts'], { join: () => name });
    const carrier = { [OPERATION]: { path, name, meta: {} } };
    expect(() => Reflect.apply(operationOf, null, [carrier])).toThrow('ARKI_CONTRACTS_E007');
  });

  it('reads the operation a carrier holds', () => {
    const op = operations(contract).posts.create;
    expect(operationOf({ [OPERATION]: op })).toBe(op);
  });

  it('throws for a value without one: a raw client leaf or a forged object must not pass as identified', () => {
    const raw: object = { call: 'a raw client leaf' };
    const forged: object = { [OPERATION]: { path: ['posts', 'create'], name: 'posts.delete', meta: {} } };
    expect(() => Reflect.apply(operationOf, null, [raw])).toThrow(TypeError);
    expect(() => Reflect.apply(operationOf, null, [forged])).toThrow(TypeError);
    expect(() => Reflect.apply(operationOf, null, [null])).toThrow(TypeError);
  });
});
