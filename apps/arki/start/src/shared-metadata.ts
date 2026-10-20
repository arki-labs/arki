import config from '~/config';

export type HeadMeta = {
  title?: string;
  description?: string;
  openGraph?: Record<string, unknown>;
  twitter?: Record<string, unknown>;
};

export const defaultMetadata: HeadMeta = {
  title: config.appDefaultTitle,
  description: config.appDescription,
  openGraph: {
    type: 'website',
    siteName: config.appTitle,
    title: config.appDefaultTitle,
    description: config.appDescription,
    url: config.appLink,
  },
  twitter: {
    card: 'summary_large_image',
    title: config.appDefaultTitle,
    description: config.appDescription,
    creator: '@arki',
  },
};

export const getDefaultMeta = (overrides: Partial<HeadMeta> = {}) => ({
  meta: [
    { title: overrides.title ?? config.appDefaultTitle },
    { name: 'description', content: overrides.description ?? config.appDescription },
    { property: 'og:title', content: overrides.title ?? config.appDefaultTitle },
    { property: 'og:description', content: overrides.description ?? config.appDescription },
    { property: 'og:site_name', content: config.appTitle },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: overrides.title ?? config.appDefaultTitle },
    { name: 'twitter:description', content: overrides.description ?? config.appDescription },
  ],
  links: [] as { rel: string; href: string }[],
  title: overrides.title ?? config.appDefaultTitle,
});
