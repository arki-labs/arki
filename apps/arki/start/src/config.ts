import type { ProjectKey } from '@fleet/sitekit/projects.ts';
import type { AppContextType } from '@fleet/sitekit/types.ts';
import { getProjectByKey } from '@fleet/sitekit/projects.ts';

import packageJSON from '../package.json';
import { env } from './env';

const projectName = packageJSON.name.split('/').shift()?.replace('@', '');

const project = getProjectByKey(projectName as ProjectKey);

if (!project) {
  throw new Error(`Project "${projectName}" not found`);
}

const config = {
  appKey: project.key as ProjectKey,
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
  appLocales: project.i18n?.locales ?? [],
  appDefaultLocale: project.i18n?.defaultLocale ?? 'en',
  appLocalePrefix: project.i18n?.localePrefix ?? 'as-needed',
  appIcon: project.icon,
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
