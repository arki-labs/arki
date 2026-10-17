import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { VFile } from 'vfile';
import { afterEach, describe, expect, it, vi } from 'vitest';

import mdxEmbedder from './mdxEmbedder/index';
import staticImages from './static-images';

function postFile(): VFile {
  const file = new VFile();
  Object.assign(file.data, { _meta: { directory: '.' } });
  return file;
}

// WHY: both plugins run async work and call `done` when it ends. On a failure they never called it: the MDX compile
// hung forever and the error surfaced only as an unhandled rejection. A failure must reject the compile.
describe('async MDX plugins', () => {
  let folder = '';

  afterEach(() => {
    vi.unstubAllGlobals();
    if (folder !== '') rmSync(folder, { recursive: true, force: true });
  });

  it('staticImages rejects when an image cannot be read', { timeout: 5000 }, async () => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'arki-content-images-'));
    const processor = unified()
      .use(remarkParse)
      .use(remarkRehype)
      .use(staticImages, { sourceRoot: folder, publicDir: path.join(folder, 'public'), resourcePath: '/posts' });

    await expect(processor.run(processor.parse('![missing](missing.png)'), postFile())).rejects.toThrow('ENOENT');
  });

  it('mdxEmbedder rejects when an embed has no snapshot', { timeout: 5000 }, async () => {
    const processor = unified().use(remarkParse).use(mdxEmbedder);

    await expect(
      processor.run(processor.parse('https://github.com/acme/widgets/issues/1'), postFile()),
    ).rejects.toThrow('has no snapshot');
  });
});
