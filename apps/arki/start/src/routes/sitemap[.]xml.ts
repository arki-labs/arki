import { createFileRoute } from '@tanstack/react-router';

import { sitemapResponse } from '@arki/sitekit/seo';

import config from '~/config';

const BUILD_DATE = new Date();

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () => {
        const base = config.appLink;
        const u = (path: string) => `${base}${path}`;

        return sitemapResponse({
          entries: [
            { url: base, lastModified: BUILD_DATE, changeFrequency: 'weekly', priority: 1 },
            ...['/about', '/posts', '/changelog', '/feedback'].map(path => ({
              url: u(path),
              lastModified: BUILD_DATE,
              changeFrequency: 'monthly' as const,
              priority: 0.7,
            })),
            ...['/legal/privacy', '/legal/terms'].map(path => ({
              url: u(path),
              lastModified: BUILD_DATE,
              changeFrequency: 'never' as const,
              priority: 0.3,
            })),
          ],
        });
      },
    },
  },
});
