import { createContext, useContext } from 'react';

const LocaleContext = createContext<string>('en');

export const LocaleProvider = ({
  locale,
  children,
}: {
  locale: string;
  children: React.ReactNode;
}) => <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;

export const useLocale = (): string => useContext(LocaleContext);
