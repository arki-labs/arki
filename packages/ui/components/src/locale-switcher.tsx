import { useLocale, useTranslations } from '@arki/intl/next-client';

import { LocaleSwitcherSelect } from './_internal/locale-switcher-select';

export function LocaleSwitcher({
  locales,
  onLocaleChange,
}: {
  locales: string[];
  onLocaleChange: (locale: string) => void;
}) {
  const t = useTranslations('LocaleSwitcher');
  const locale = useLocale();

  if (locales.length === 1) {
    return null;
  }

  return (
    <LocaleSwitcherSelect defaultValue={locale} label={t('label')} onLocaleChange={onLocaleChange}>
      {locales.map(cur => (
        <option key={cur} value={cur}>
          {t('locale', { locale: cur })}
        </option>
      ))}
    </LocaleSwitcherSelect>
  );
}
