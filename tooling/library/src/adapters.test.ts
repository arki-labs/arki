import { describe, expect, it } from 'vitest';

import { isAdapterSubpath } from './adapters';

describe('isAdapterSubpath', () => {
  it('treats ./redis and ./file as adapters (platform-bound stores, exempt from portable lint)', () => {
    expect(isAdapterSubpath('./redis')).toBe(true);
    expect(isAdapterSubpath('./file')).toBe(true);
  });

  it('uses the first segment, so nested entries of an adapter are adapters too', () => {
    expect(isAdapterSubpath('./pg/lease')).toBe(true);
  });

  it('keeps plain subpaths portable', () => {
    expect(isAdapterSubpath('./memory')).toBe(false);
  });
});
