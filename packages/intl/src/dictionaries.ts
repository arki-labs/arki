const generalDictionaries = {
  en: () => import('./dictionaries/en.js').then(mod => mod.default),
  de: () => import('./dictionaries/de.js').then(mod => mod.default),
} as const;

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
) => {
  let messages: MessageCollection = {};

  const dictionaries = [generalDictionaries, ...featureDictionaries];

  for (const dictionary of dictionaries) {
    // Own keys only: the locale is outside text, and `'__proto__'` or `'toString'` must not match a prototype member.
    const load = Object.hasOwn(dictionary, locale)
      ? dictionary[locale as keyof typeof dictionary]
      : Object.hasOwn(dictionary, defaultLocale)
        ? dictionary[defaultLocale as keyof typeof dictionary]
        : undefined;
    if (load !== undefined) messages = deepMerge(messages, await load());
  }

  return messages;
};
