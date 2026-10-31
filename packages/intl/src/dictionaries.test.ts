import { describe, expect, it } from 'vitest';

import { loadMessagesFromMultipleDictionaries } from './dictionaries.js';
import enMessages from './dictionaries/en.js';

const feature = { en: () => ({ extra: 'x' }), de: () => ({ extra: 'y' }) };

describe('loadMessagesFromMultipleDictionaries', () => {
  it('loads the requested locale and merges feature dictionaries', async () => {
    const messages = await loadMessagesFromMultipleDictionaries('de', 'en', [feature]);
    expect(messages.extra).toBe('y');
  });

  it('falls back to the default locale for a locale no dictionary has', async () => {
    const messages = await loadMessagesFromMultipleDictionaries('fr', 'en', [feature]);
    expect(messages).toEqual(await loadMessagesFromMultipleDictionaries('en', 'en', [feature]));
    expect(messages.extra).toBe('x');
  });

  it.each(['__proto__', 'toString', 'constructor', 'hasOwnProperty'])(
    'treats the locale %s as unknown text and uses the default locale',
    async locale => {
      const messages = await loadMessagesFromMultipleDictionaries(locale, 'en', [feature]);
      expect(messages).toEqual({ ...enMessages, extra: 'x' });
    },
  );
});
