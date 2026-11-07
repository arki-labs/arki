import { describe, expect, it } from 'vitest';

import { orThrow } from '@arki/failure';

import { DictionaryLoadFailed, loadMessagesFromMultipleDictionaries } from './dictionaries.js';
import enMessages from './dictionaries/en.js';

const feature = { en: () => ({ extra: 'x' }), de: () => ({ extra: 'y' }) };

describe('loadMessagesFromMultipleDictionaries', () => {
  it('loads the requested locale and merges feature dictionaries', async () => {
    const messages = orThrow(await loadMessagesFromMultipleDictionaries('de', 'en', [feature]));
    expect(messages.extra).toBe('y');
  });

  it('falls back to the default locale for a locale no dictionary has', async () => {
    const messages = orThrow(await loadMessagesFromMultipleDictionaries('fr', 'en', [feature]));
    expect(messages).toEqual(orThrow(await loadMessagesFromMultipleDictionaries('en', 'en', [feature])));
    expect(messages.extra).toBe('x');
  });

  it.each(['__proto__', 'toString', 'constructor', 'hasOwnProperty'])(
    'treats the locale %s as unknown text and uses the default locale',
    async locale => {
      const messages = orThrow(await loadMessagesFromMultipleDictionaries(locale, 'en', [feature]));
      expect(messages).toEqual({ ...enMessages, extra: 'x' });
    },
  );

  // Why: a dictionary chunk is code loaded from outside the caller's control; a network error must not reject the page load.
  it('returns DictionaryLoadFailed with the cause when a feature loader rejects', async () => {
    const cause = new Error('chunk 404');
    const broken = { en: () => Promise.reject(cause) };
    const result = await loadMessagesFromMultipleDictionaries('en', 'en', [broken]);
    expect(result).toMatchObject({ code: DictionaryLoadFailed.code });
    expect(result).toHaveProperty('cause', cause);
  });

  it('returns DictionaryLoadFailed when a feature loader throws synchronously', async () => {
    const throwing = {
      en: (): never => {
        throw new Error('boom');
      },
    };
    expect(await loadMessagesFromMultipleDictionaries('en', 'en', [throwing])).toMatchObject({
      code: DictionaryLoadFailed.code,
    });
  });
});
