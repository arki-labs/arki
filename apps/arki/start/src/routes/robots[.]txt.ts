import { createFileRoute } from '@tanstack/react-router';

import { robotsTxtResponse } from '@arki/seo';

import { getBaseUrl } from '~/config';

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () =>
        robotsTxtResponse({
          baseUrl: getBaseUrl(),
          disallow: ['/api/', '/auth/', '/backoffice/'],
        }),
    },
  },
});
