import type { AppContextType } from '@fleet/sitekit/types.ts';
import { CubeIcon } from '@arki/icons/phosphor';
// This app's own entry, so the other projects' data is not downloaded with it.
import { arkiData as project } from '@fleet/sitekit/project-data/arki';

import packageJSON from '../package.json';
import { env } from './env';

const config = {
  appKey: project.key,
  appTitle: project.title,
  appDefaultTitle: project.title + ' - ' + project.tagline,
  appDescription: project.description,
  appShortDescription: project.shortDescription,
  appLink: project.link,
  appDomain: project.domain,
  appVersion: packageJSON.version,
  appAuthor: project.author.name,
  appAuthorAvatar: project.author.avatar,
  appIntegrations: project.integrations,
  appLocales: project.i18n.locales,
  appDefaultLocale: project.i18n.defaultLocale,
  appLocalePrefix: project.i18n.localePrefix,
  // Imported here rather than read from `@fleet/sitekit/projects`, which imports every fleet project's icon.
  appIcon: CubeIcon,
} satisfies AppContextType;

export default config;

export const createCompleteUrl = (path: string) => {
  if (path.startsWith('/')) {
    return `${getBaseUrl()}${path}`;
  }
  return `${getBaseUrl()}/${path}`;
};

export const createImageUrl = (src: string, width: number, height: number, escape = false) => {
  if (src.startsWith('https://images.unsplash.com/') && !src.includes('?')) {
    const amp = escape ? '&amp;' : '&';
    return `${src}?fit=crop${amp}w=${width}${amp}h=${height}`;
  } else if (!src.includes('://')) {
    return createCompleteUrl(src);
  }
  return src;
};

export const getBaseUrl = () => {
  if (env.VITE_URL) {
    return env.VITE_URL;
  }
  return 'http://localhost:3000';
};
