import { oc } from '@orpc/contract';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { defineId } from './ids.js';
import { operationAt } from './orpc.js';

const contract = { posts: { list: oc.input(z.object({})).output(z.array(z.string())) } };

it('operationAt returns undefined for a path that is missing, too deep or not a procedure', () => {
  expect(operationAt(contract, ['posts', 'missing'])).toBeUndefined();
  expect(operationAt(contract, ['posts'])).toBeUndefined();
  expect(operationAt(contract, ['posts', 'list', 'deeper'])).toBeUndefined();
  expect(operationAt(contract, ['nope', 'list'])).toBeUndefined();
  expect(operationAt(contract, [])).toBeUndefined();
  expect(operationAt(contract, ['posts', 'list'])?.name).toBe('posts.list');
});

it('an id declaration accepts any value in is() and never throws', () => {
  const postId = defineId('post_');
  for (const value of [null, undefined, 1n, Symbol('x'), Object.create(null), [], () => 1, 'post_', 'x']) {
    expect(() => postId.is(value)).not.toThrow();
  }
  expect(postId.is('post_abc')).toBe(true);
  expect(postId.is('abc')).toBe(false);
});
