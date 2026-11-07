import { defineFailure } from '@arki/failure';

const generalDictionaries = {
  en: () => import('./dictionaries/en.js').then(mod => mod.default),
  de: () => import('./dictionaries/de.js').then(mod => mod.default),
} as const;

/**
 * A dictionary could not be loaded: a chunk failed to download or import, or a feature loader rejected. The
 * cause is on the failure; no partial messages are returned.
 * @fix Check the network and the deployed dictionary chunks, then load again.
 * @verify bun run test -- src/dictionaries.test.ts
 */
export const DictionaryLoadFailed = defineFailure('intl.dictionary_load_failed', {
  status: 503,
  message: 'A message dictionary failed to load.',
  remediation: 'Check the network and the deployed dictionary chunks, then load again.',
});
/** A {@link DictionaryLoadFailed} failure value. */
export type DictionaryLoadFailed = ReturnType<typeof DictionaryLoadFailed>;

type MessageCollection = {
  [key: string]: string | MessageCollection;
};

function deepMerge(target: MessageCollection, source: MessageCollection): MessageCollection {
  const output = { ...target };

  for (const key in source) {
    output[key] =
      source[key] instanceof Object && key in target && target[key] instanceof Object
        ? deepMerge(target[key], source[key])
        : source[key]!;
  }

  return output;
}
export const loadMessagesFromMultipleDictionaries = async (
  locale: string,
  defaultLocale: string,
  featureDictionaries: Record<string, () => Promise<MessageCollection> | MessageCollection>[],
): Promise<MessageCollection | DictionaryLoadFailed> => {
  let messages: MessageCollection = {};

  const dictionaries = [generalDictionaries, ...featureDictionaries];

  for (const dictionary of dictionaries) {
    // Own keys only: the locale is outside text, and `'__proto__'` or `'toString'` must not match a prototype member.
    const load = Object.hasOwn(dictionary, locale)
      ? dictionary[locale as keyof typeof dictionary]
      : Object.hasOwn(dictionary, defaultLocale)
        ? dictionary[defaultLocale as keyof typeof dictionary]
        : undefined;
    if (load === undefined) continue;
    try {
      messages = deepMerge(messages, await load());
    } catch (error) {
      return DictionaryLoadFailed({ cause: error });
    }
  }

  return messages;
};
