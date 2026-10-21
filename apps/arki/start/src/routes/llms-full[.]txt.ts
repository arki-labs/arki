import { createFileRoute } from '@tanstack/react-router';

import { latestSnapshotFolder } from '~/features/site-data/package-urls';
import { getSnapshotFileFn, listPackagesFn } from '~/features/site-data/site-data';

import { buildLlmsFull } from './agents/-llms';
import { readGlossaryMarkdown } from './docs/-glossary-data.server';

export const Route = createFileRoute('/llms-full.txt')({
  server: {
    handlers: {
      GET: async () => {
        const entries = await listPackagesFn();
        const packages = await Promise.all(
          entries.map(async entry => {
            const version = latestSnapshotFolder(entry);
            if (version === null) return { entry, llmsText: null, agentGuideText: null, agentsText: null };
            const [llmsText, agentGuideText, agentsText] = await Promise.all([
              getSnapshotFileFn({ data: { short: entry.short, version, file: 'llms.txt' } }),
              getSnapshotFileFn({ data: { short: entry.short, version, file: 'docs/agent-guide.md' } }),
              getSnapshotFileFn({ data: { short: entry.short, version, file: 'AGENTS.md' } }),
            ]);
            return { entry, llmsText, agentGuideText, agentsText };
          }),
        );
        return new Response(buildLlmsFull(readGlossaryMarkdown(), packages), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      },
    },
  },
});
