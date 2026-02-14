import { describe, expect, it } from 'vitest';

import { defaultUiDesignSystemId, resolveUiDesignSystemId } from './design-system';

describe('@arki/ui design system helpers', () => {
  it('uses atelier as the default id', () => {
    expect(defaultUiDesignSystemId).toBe('atelier');
  });

  it('resolves known ids unchanged', () => {
    expect(resolveUiDesignSystemId('workbench')).toBe('workbench');
  });

  it('falls back to default for invalid values', () => {
    expect(resolveUiDesignSystemId('unknown')).toBe('atelier');
  });
});
