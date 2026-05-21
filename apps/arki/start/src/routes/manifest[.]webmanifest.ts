import { createFileRoute } from '@tanstack/react-router';

import config from '~/config';

export const Route = createFileRoute('/manifest.webmanifest')({
  server: {
    handlers: {
      GET: () => {
        const manifest = {
          name: config.appDefaultTitle,
          short_name: config.appTitle,
          description: config.appDescription,
          start_url: '/',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#ffffff',
          theme_color: '#ffffff',
          icons: [
            { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        };

        return new Response(JSON.stringify(manifest, null, 2), {
          headers: {
            'Content-Type': 'application/manifest+json; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      },
    },
  },
});
