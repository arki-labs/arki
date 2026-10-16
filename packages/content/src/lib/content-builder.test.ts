import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentBuildError, createContentBuilder } from './content-builder';

// The fixture lives inside the package so its config can import `@content-collections/core` from node_modules.
const cacheFolder = fileURLToPath(new URL('../../.cache', import.meta.url));

const config = `
import { defineCollection, defineConfig } from '@content-collections/core';
import { z } from 'zod';

const notes = defineCollection({
  name: 'notes',
  directory: 'notes',
  include: '*.md',
  schema: z.object({ title: z.string(), content: z.string() }),
});

export default defineConfig({ content: [notes] });
`;

describe('createContentBuilder', () => {
  const startFolder = process.cwd();
  let app = '';

  beforeEach(() => {
    mkdirSync(cacheFolder, { recursive: true });
    app = mkdtempSync(path.join(cacheFolder, 'content-builder-'));
    mkdirSync(path.join(app, 'notes'));
    writeFileSync(path.join(app, 'content.config.ts'), config);
    writeFileSync(path.join(app, 'notes', 'good.md'), '---\ntitle: Good\n---\n\nBody\n');
    process.chdir(app);
  });

  afterEach(() => {
    process.chdir(startFolder);
    rmSync(app, { recursive: true, force: true });
  });

  it('builds valid content', async () => {
    const content = await createContentBuilder(path.join(app, 'content.config.ts'));
    await expect(content.build()).resolves.toMatchObject({ collections: 1, documents: 1 });
  });

  // WHY: upstream reads the files inside createBuilder, before its own plugin attaches a listener. A broken file was
  // then dropped without a word and the site shipped without that page. The build must fail and name the file.
  it('fails the build on a file that was broken before the builder existed', async () => {
    writeFileSync(path.join(app, 'notes', 'broken.md'), '---\ntitle: "Broken\n---\n\nBody\n');
    const content = await createContentBuilder(path.join(app, 'content.config.ts'));

    const failure: unknown = await content.build().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentBuildError);
    expect(failure instanceof ContentBuildError ? failure.problems.join('\n') : '').toContain(
      path.join('notes', 'broken.md'),
    );
  });

  it('fails the build on a document that does not match its schema', async () => {
    writeFileSync(path.join(app, 'notes', 'untitled.md'), '---\nsubtitle: No title\n---\n\nBody\n');
    const content = await createContentBuilder(path.join(app, 'content.config.ts'));
    await expect(content.build()).rejects.toThrow(path.join('notes', 'untitled.md'));
  });

  // WHY: collection folders, copied images and git dates resolve against the current folder. Running from elsewhere
  // would silently build an empty site.
  it('refuses to run outside the config folder', async () => {
    process.chdir(cacheFolder);
    await expect(createContentBuilder(path.join(app, 'content.config.ts'))).rejects.toThrow('run from');
  });
});
