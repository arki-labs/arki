import { createServer } from 'node:http';
import type { Server } from 'node:http';
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

  describe('remote images', () => {
    let server: Server | undefined;

    afterEach(() => {
      server?.closeAllConnections();
      server?.close();
      server = undefined;
    });

    async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
      server = createServer(handler);
      await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      return `http://127.0.0.1:${String(address.port)}/cover.png`;
    }

    // A server that never answers must not hang the whole content build.
    it('fails when the remote server does not answer in time', async () => {
      const url = await serve(() => {
        // No response, on purpose.
      });

      await expect(resolveImageBlurDataURL('posts', 'post', url, { timeoutMs: 50 })).rejects.toThrow();
    });

    // A wrong URL (a video, an ISO) must not be read into memory without end.
    it('refuses a remote image whose declared size is over the cap before reading any of it', async () => {
      const url = await serve((_request, response) => {
        // Promises 1 MB, sends the headers and then nothing: only the declared size can end this fetch early.
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '1000000' });
        response.flushHeaders();
      });

      await expect(resolveImageBlurDataURL('posts', 'post', url, { maxBytes: 1024 })).rejects.toThrow(/the limit is/);
    });

    it('stops reading when the server hides the size and streams more than the cap', async () => {
      const url = await serve((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' });
        response.write(Buffer.alloc(2048));
        response.end(Buffer.alloc(2048));
      });

      await expect(resolveImageBlurDataURL('posts', 'post', url, { maxBytes: 1024 })).rejects.toThrow(/limit|larger/);
    });
  });
});

