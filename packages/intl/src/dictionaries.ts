const generalDictionaries = {
  en: () => import('./dictionaries/en').then(mod => mod.default),
  de: () => import('./dictionaries/de').then(mod => mod.default),
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
    if (locale in dictionary) {
      messages = deepMerge(messages, await dictionary[locale as keyof typeof dictionary]());
    } else if (defaultLocale in dictionary) {
      messages = deepMerge(messages, await dictionary[defaultLocale as keyof typeof dictionary]());
    }
  }

  return messages;
};
