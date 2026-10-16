#!/usr/bin/env node
/**
 * `arki-content generate`: builds the app's content into `.content-collections/generated`, the same build
 * `contentPlugin` runs in `vite build`. Run it from the app folder (the one with `content.config.ts`), before
 * `tsc`, so a fresh clone type-checks. Exit codes: 0 ok, 1 a content file failed, 2 wrong usage.
 */
import path from 'node:path';

import { CONTENT_CONFIG_FILE, createContentBuilder } from './lib/content-builder.js';

async function main(args: readonly string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== 'generate') {
    process.stderr.write('usage: arki-content generate\n');
    return 2;
  }
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
