import { describe, expect, it } from 'vitest';

import deMessages from '../../dictionaries/de';
import enMessages from '../../dictionaries/en';

import { builtinMessagesFor } from './builtin-messages';

describe('builtinMessagesFor', () => {
  it('picks the dictionary of a built-in locale', () => {
    expect(builtinMessagesFor('de')).toBe(deMessages);
    expect(builtinMessagesFor('en')).toBe(enMessages);
  });

  it.each(['fr', '__proto__', 'constructor', 'toString'])('falls back to English for %s', locale => {
    expect(builtinMessagesFor(locale)).toBe(enMessages);
  });
});
