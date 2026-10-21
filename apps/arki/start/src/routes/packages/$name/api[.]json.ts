import { createFileRoute } from '@tanstack/react-router';

import { latestSnapshotFolder } from '~/features/site-data/package-urls';
import { getPackageFn, getSnapshotFileFn } from '~/features/site-data/site-data';

/** The latest snapshot's `api.json`, byte for byte. 404 when the package or its API index is unknown. */
export const Route = createFileRoute('/packages/$name/api.json')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const entry = await getPackageFn({ data: { short: params.name } });
        const folder = entry === null ? null : latestSnapshotFolder(entry);
        const body =
          entry === null || folder === null
            ? null
            : await getSnapshotFileFn({ data: { short: entry.short, version: folder, file: 'api.json' } });
        if (body === null) return new Response('Not found', { status: 404 });
        return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8' } });
      },
    },
  },
});
