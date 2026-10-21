import type { ReactNode } from 'react';

import { AppLocaleProvider } from '@arki/intl/tanstack-start';

import { getLocale } from '~/paraglide/runtime.js';

/**
 * The translation context (`use-intl`) for the current request's locale. Mounted only where a component reads
 * translations (posts, changelog, signed-in pages), not in `__root`: its message formatter would otherwise ship in
 * the JavaScript of every docs page.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  return <AppLocaleProvider locale={getLocale()}>{children}</AppLocaleProvider>;
}
