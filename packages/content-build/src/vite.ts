import path from 'node:path';
import type { Modification } from '@content-collections/core';
import type { Logger, Plugin } from 'vite';

import type { ContentBuilder, ContentBuildStats } from './lib/content-builder.js';
import { CONTENT_CONFIG_FILE, createContentBuilder } from './lib/content-builder.js';

const describe = ({ collections, documents, ms }: ContentBuildStats): string =>
  `built ${collections} collections, ${documents} documents in ${ms}ms`;

/**
 * Builds the app's `content.config.ts` into `.content-collections/generated` (imported as `content-collections`).
 * `vite build` builds once and fails on any broken content file; `vite dev` rebuilds on change and only reports.
 */
export function contentPlugin(): Plugin {
  let builder: ContentBuilder | undefined;
  let initialBuild: Promise<void> | undefined;
  let logger: Logger | undefined;
  let failOnError = true;

  const report = (problems: readonly string[]): void => {
    for (const problem of problems) logger?.error(`[arki-content] ${problem}`, { timestamp: true });
  };

  return {
    name: 'arki-content',
    config(config) {
      const generated = path.resolve(config.root ?? process.cwd(), '.content-collections', 'generated');
      const allowsOnlyListed = (config.server?.fs?.allow ?? []).length > 0;
      return {
        optimizeDeps: { exclude: ['content-collections'] },
        resolve: { alias: { 'content-collections': generated } },
        ...(allowsOnlyListed ? { server: { fs: { allow: [generated] } } } : {}),
      };
    },
    async configResolved(config) {
      logger = config.logger;
      failOnError = config.command === 'build';
      builder ??= await createContentBuilder(path.join(config.root, CONTENT_CONFIG_FILE));
    },
    // Vite calls buildStart once per environment (client, ssr); the content is built once per process.
    async buildStart() {
      const content = builder;
      if (content === undefined) return;
      initialBuild ??= content.build().then(
        stats => logger?.info(`[arki-content] ${describe(stats)}`, { timestamp: true }),
        (error: unknown) => {
          if (failOnError) throw error;
          logger?.error(`[arki-content] ${error instanceof Error ? error.message : String(error)}`, {
            timestamp: true,
          });
        },
      );
      await initialBuild;
    },
    configureServer(server) {
      const cacheFolder = path.join(server.config.root, '.content-collections') + path.sep;
      const onFile = (modification: Modification) => (filePath: string) => {
        if (builder === undefined || filePath.startsWith(cacheFolder)) return;
        builder.sync(modification, filePath).then(report, (error: unknown) => report([String(error)]));
      };
      server.watcher.on('add', onFile('create'));
      server.watcher.on('change', onFile('update'));
      server.watcher.on('unlink', onFile('delete'));
    },
  };
}
