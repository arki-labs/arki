import type { createNavigation } from 'next-intl/navigation';

export { createNavigation } from 'next-intl/navigation';

export type IntlLink = ReturnType<typeof createNavigation>['Link'];
