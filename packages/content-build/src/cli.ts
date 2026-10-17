#!/usr/bin/env node
/**
 * `arki-content generate`: builds the app's content into `.content-collections/generated`, the same build
 * `contentPlugin` runs in `vite build`. Run it from the app folder (the one with `content.config.ts`), before
 * `tsc`, so a fresh clone type-checks. Exit codes: 0 ok, 1 a content file failed, 2 wrong usage.
 *
 * `arki-content snapshot`: fetches every GitHub issue/PR and tweet the content embeds and writes its snapshot under
 * `src/content/.embeds/` (commit them: the build reads them and never fetches). Removes unused snapshots. Run it
 * from the app folder after adding an embed. Exit codes: 0 ok, 1 a fetch failed, 2 wrong usage.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CONTENT_CONFIG_FILE, createContentBuilder } from './lib/content-builder.js';
import { snapshotEmbeds } from './lib/mdxEmbedder/snapshot.js';

async function snapshot(): Promise<number> {
  if (!existsSync(CONTENT_CONFIG_FILE)) {
    throw new Error(
      `run from the app folder, the one with ${CONTENT_CONFIG_FILE} (the current folder is ${process.cwd()})`,
    );
  }
  const { embeds, written, unchanged, removed, failed } = await snapshotEmbeds(process.cwd());
  for (const { file, url } of written) process.stdout.write(`wrote ${file} (${url})\n`);
  for (const file of removed) process.stdout.write(`removed ${file} (no document embeds it)\n`);
  for (const { url, document, error } of failed) process.stderr.write(`failed ${url} (in ${document}): ${error}\n`);
  process.stdout.write(
    `arki-content: ${embeds} embeds, ${written.length} written, ${unchanged} unchanged, ${removed.length} removed, ${failed.length} failed\n`,
  );
  return failed.length > 0 ? 1 : 0;
}

async function main(args: readonly string[]): Promise<number> {
  const [command] = args;
  if (args.length !== 1 || (command !== 'generate' && command !== 'snapshot')) {
    process.stderr.write('usage: arki-content generate | arki-content snapshot\n');
    return 2;
  }
  if (command === 'snapshot') return snapshot();
  const content = await createContentBuilder(path.resolve(CONTENT_CONFIG_FILE));
  const { collections, documents, ms } = await content.build();
  process.stdout.write(`arki-content: built ${collections} collections, ${documents} documents in ${ms}ms\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`arki-content: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
