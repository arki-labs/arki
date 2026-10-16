import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import resolveImageBlurDataURL from './imageBlurDataURL';

async function writeImage(file: string, color: { r: number; g: number; b: number }) {
  mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 16, height: 12, channels: 3, background: color } })
    .png()
    .toFile(file);
}

describe('resolveImageBlurDataURL', () => {
  const startFolder = process.cwd();
  let app = '';

  beforeEach(() => {
    // The placeholder cache is written below the current folder.
    app = mkdtempSync(path.join(os.tmpdir(), 'arki-content-blur-'));
    process.chdir(app);
  });

  afterEach(() => {
    process.chdir(startFolder);
    rmSync(app, { recursive: true, force: true });
  });

  // WHY: the cache was keyed on the file name, so every post with a `cover.png` showed the first post's placeholder.
  it('gives two posts with the same image name their own placeholder', async () => {
    await writeImage(path.join(app, 'posts', 'red', 'cover.png'), { r: 255, g: 0, b: 0 });
    await writeImage(path.join(app, 'posts', 'blue', 'cover.png'), { r: 0, g: 0, b: 255 });

    const red = await resolveImageBlurDataURL('posts', 'red', 'cover.png');
    const blue = await resolveImageBlurDataURL('posts', 'blue', 'cover.png');

    expect(red).toMatch(/^data:image\//);
    expect(blue).not.toBe(red);
  });

  it('gives a replaced image a new placeholder', async () => {
    const file = path.join(app, 'posts', 'post', 'cover.png');
    await writeImage(file, { r: 255, g: 0, b: 0 });
    const before = await resolveImageBlurDataURL('posts', 'post', 'cover.png');

    await writeImage(file, { r: 0, g: 255, b: 0 });
    const after = await resolveImageBlurDataURL('posts', 'post', 'cover.png');

    expect(after).not.toBe(before);
  });
});
