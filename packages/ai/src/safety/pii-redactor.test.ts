/**
 * A caller's own PII pattern must neither hang the redactor nor slip past it, whatever flags it carries.
 */
import { describe, expect, it } from 'vitest';

import { PIIRedactor } from './pii-redactor';

const customOnly = (pattern: RegExp) =>
  new PIIRedactor([{ pattern, replacement: '[ID]', description: 'Internal id' }], true);

describe('PIIRedactor with caller patterns (F9)', () => {
  it('a pattern without the g flag ends and finds every match', () => {
    // WHY: `while (regex.exec(...))` on a non-global regex matched the first id forever.
    const redactor = customOnly(/ID-\d+/);

    const result = redactor.redact('ID-1 and ID-2');

    expect(result.piiCount).toBe(2);
    expect(result.redactedText).toBe('[ID] and [ID]');
    expect(redactor.detect('ID-1 and ID-2').map(issue => issue.matchedText)).toEqual(['ID-1', 'ID-2']);
  });

  it('a pattern that matches empty text ends', () => {
    const redactor = customOnly(/x*/g);

    expect(redactor.detect('abc').every(issue => issue.matchedText === '')).toBe(true);
    expect(redactor.redact('ab').redactedText).toBe('[ID]a[ID]b[ID]');
  });

  it('a sticky (y) pattern still finds a match that is not at the start, on every call', () => {
    // WHY: `y` pins the scan to lastIndex, so PII after the first character was missed.
    const redactor = customOnly(/ID-\d+/y);

    for (let call = 0; call < 2; call++) {
      expect(redactor.hasPII('see ID-7')).toBe(true);
      expect(redactor.redact('see ID-7').redactedText).toBe('see [ID]');
    }
  });
});
