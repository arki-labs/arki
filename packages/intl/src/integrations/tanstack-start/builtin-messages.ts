import deMessages from '../../dictionaries/de.js';
import enMessages from '../../dictionaries/en.js';

export type MessageBag = Record<string, unknown>;

const BUILTIN_MESSAGES: Record<string, MessageBag> = {
  en: enMessages,
  de: deMessages,
};

/**
 * The built-in bag for a locale. A locale is outside text (cookie, URL, header), so only own keys count:
 * `'__proto__'` and `'constructor'` fall back to English instead of picking an `Object.prototype` member.
 */
export const builtinMessagesFor = (locale: string): MessageBag =>
  Object.hasOwn(BUILTIN_MESSAGES, locale) ? BUILTIN_MESSAGES[locale]! : BUILTIN_MESSAGES.en!;
