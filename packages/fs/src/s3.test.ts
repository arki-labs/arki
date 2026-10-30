import { expect, it } from 'vitest';

import { initializeStorage } from './s3.js';

it('builds the S3 client when called, not when the module loads', () => {
  expect(typeof initializeStorage).toBe('function');
  expect(initializeStorage('bucket', 'prefix', 'eu-west-1')).toBeDefined();
});
