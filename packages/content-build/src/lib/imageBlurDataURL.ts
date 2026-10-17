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

const fetchImage = async (imageUrl: string): Promise<Buffer> => {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`failed to fetch ${imageUrl}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

/**
 * A local image is keyed by its bytes, so two posts with a `cover.jpg` get their own placeholder and a replaced
 * image gets a new one. A remote image is keyed by its URL, so the build does not download it again.
 */
const resolveImageBlurDataURL = async (sourceRoot: string, directory: string, image: string) => {
  if (image.includes('://')) {
    const checksum = sha256sum(image);
    return (await resolveFromFile(checksum)) ?? createBlurDataURL(await fetchImage(image), checksum);
  }

  const buffer = await readFile(path.join(sourceRoot, directory, image));
  const checksum = sha256sum(buffer);
  return (await resolveFromFile(checksum)) ?? createBlurDataURL(buffer, checksum);
};

export default resolveImageBlurDataURL;
