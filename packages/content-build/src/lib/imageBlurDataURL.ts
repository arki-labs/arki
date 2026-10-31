import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import createPlaceholder from './placeholder.js';

const cacheDir = path.join('.content-collections', 'cache', 'images');

const sha256sum = (value: string | Buffer) => {
  return createHash('sha256').update(value).digest('hex');
};

/** The cached placeholder, or `null` when there is none yet (no file, or one that cannot be read). */
const resolveFromFile = (checksum: string): Promise<string | null> =>
  readFile(path.join(cacheDir, checksum), { encoding: 'utf8' }).catch(() => null);

const createBlurDataURL = async (buffer: Buffer, checksum: string) => {
  const image = sharp(buffer);
  const blurDataURL = await createPlaceholder(image);

  const file = path.join(cacheDir, checksum);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, blurDataURL, { encoding: 'utf8' });

  return blurDataURL;
};

export type RemoteImageLimits = {
  /** A remote cover that does not answer within this time fails the build instead of stalling it. Default 15 s. */
  timeoutMs?: number;
  /** The most bytes read from a remote cover: a placeholder never needs more, and a wrong URL must not fill memory. Default 20 MiB. */
  maxBytes?: number;
};

const fetchImage = async (imageUrl: string, limits: RemoteImageLimits): Promise<Buffer> => {
  const { timeoutMs = 15_000, maxBytes: maxBytes = 20 * 1024 * 1024 } = limits;
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`failed to fetch ${imageUrl}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    throw new Error(`${imageUrl} is ${String(declared)} bytes; the limit is ${String(maxBytes)}`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`${imageUrl} is larger than ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/**
 * A local image is keyed by its bytes, so two posts with a `cover.jpg` get their own placeholder and a replaced
 * image gets a new one. A remote image is keyed by its URL, so the build does not download it again.
 */
const resolveImageBlurDataURL = async (
  sourceRoot: string,
  directory: string,
  image: string,
  limits: RemoteImageLimits = {},
) => {
  if (image.includes('://')) {
    const checksum = sha256sum(image);
    return (await resolveFromFile(checksum)) ?? createBlurDataURL(await fetchImage(image, limits), checksum);
  }

  const buffer = await readFile(path.join(sourceRoot, directory, image));
  const checksum = sha256sum(buffer);
  return (await resolveFromFile(checksum)) ?? createBlurDataURL(buffer, checksum);
};

export default resolveImageBlurDataURL;

