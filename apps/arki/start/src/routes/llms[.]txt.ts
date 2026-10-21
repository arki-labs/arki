import { createFileRoute } from '@tanstack/react-router';

import { getBaseUrl } from '~/config';
import { getSnapshotFileFn, listPackagesFn } from '~/features/site-data/site-data';
import { latestSnapshotFolder } from '~/features/site-data/package-urls';

import { buildLlmsIndex } from './agents/-llms';

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: async () => {
        const entries = await listPackagesFn();
        const packages = await Promise.all(
          entries.map(async entry => {
            const version = latestSnapshotFolder(entry);
            const llmsText =
              version === null ? null : await getSnapshotFileFn({ data: { short: entry.short, version, file: 'llms.txt' } });
            return { entry, llmsText };
          }),
        );
        return new Response(buildLlmsIndex(packages, getBaseUrl()), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      },
    },
  },
});
