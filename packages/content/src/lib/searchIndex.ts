import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Post } from '../models';
import { createPostSearchIndex } from './search';

export default async function searchIndex(posts: Post[], outputPath: string) {
  if (posts.length === 0) {
    return;
  }

  const data = createPostSearchIndex(posts).toJSON();

  const directory = path.join(outputPath, 'Post');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'search-index.json'), JSON.stringify(data), {
    encoding: 'utf8',
  });
}
