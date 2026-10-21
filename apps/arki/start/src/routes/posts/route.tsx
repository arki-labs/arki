import { createFileRoute, Outlet } from '@tanstack/react-router';

import { LocaleProvider } from '~/shared/locale-provider';

export const Route = createFileRoute('/posts')({
  component: TranslatedSectionLayout,
});

// Post and changelog pages render `@arki/content-react` timelines, which read translations.
function TranslatedSectionLayout() {
  return (
    <LocaleProvider>
      <Outlet />
    </LocaleProvider>
  );
}
