import type { ReactNode } from 'react';

import deMessages from '../../dictionaries/de';
import enMessages from '../../dictionaries/en';

import { LocaleProvider } from './context';

type MessageBag = Record<string, unknown>;

const BUILTIN_MESSAGES: Record<string, MessageBag> = {
  en: enMessages,
  de: deMessages,
};

/**
 * Drop-in intl provider for TanStack Start apps.
 *
 * Given a `locale`, selects the matching built-in dictionary from `@arki/intl`
 * and mounts the underlying {@link LocaleProvider}, so shared components that
 * call `useTranslations()`/`useLocale()` (e.g. `@fleet/sitekit`'s `ComingSoon`,
 * `LocaleSwitcher`, feedback templates) work without each app re-wiring intl.
 *
 * Apps that define their own feature-level messages can merge them via the
 * optional `messages` prop; they're shallow-merged on top of the built-in bag,
 * so app keys can override built-ins deliberately.
 */
export const AppLocaleProvider = ({
  locale = 'en',
  messages,
  timeZone = 'UTC',
  children,
}: {
  locale?: string;
  messages?: MessageBag;
  /**
   * Explicit IANA time zone forwarded to use-intl. Defaults to `'UTC'` for
   * deterministic SSR; pass an app's canonical zone if dates must display in a
   * specific region.
   */
  timeZone?: string;
  children: ReactNode;
}) => {
  const baseMessages = BUILTIN_MESSAGES[locale] ?? BUILTIN_MESSAGES.en!;
  const merged = messages ? { ...baseMessages, ...messages } : baseMessages;

  return (
    <LocaleProvider locale={locale} messages={merged} timeZone={timeZone}>
      {children}
    </LocaleProvider>
  );
};
