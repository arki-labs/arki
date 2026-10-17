import { expect, it } from 'vitest';

import { label, PostNotFound, titleOf, titleOrDraft } from './posts.js';

it('returns the value, or the failure, and the handlers see both', async () => {
  expect(await titleOf('p1')).toBe('Hello');
  expect(PostNotFound.is(await titleOf('p9'))).toBe(true);
  expect(await label('p1')).toBe('Hello');
  expect(await label('p9')).toBe('missing p9');
  expect(await titleOrDraft('p9')).toBe('Untitled draft');
});
