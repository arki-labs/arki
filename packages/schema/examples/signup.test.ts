import { expect, it } from 'vitest';

import { fieldErrors } from './signup.js';

it('names the bad field and stays quiet for good input', () => {
  expect(fieldErrors({ name: 'Ada', age: 36 })).toEqual({});
  expect(Object.keys(fieldErrors({ name: 'Ada', age: 'old' }))).toEqual(['age']);
});
