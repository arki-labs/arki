import type { createNavigation } from 'next-intl/navigation';

export {
  createLocalizedPathnamesNavigation,
  createNavigation,
  createSharedPathnamesNavigation,
  type Pathnames,
} from 'next-intl/navigation';

export type IntlLink = ReturnType<typeof createNavigation>['Link'];
