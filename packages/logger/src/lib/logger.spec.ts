import { describe, expect, it } from 'vitest';

import { Logger } from './logger';

describe('logger', () => {
  it('should work', () => {
    expect(new Logger()).toEqual('logger');
  });
});
