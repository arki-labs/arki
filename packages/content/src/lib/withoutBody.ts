import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Post } from '../collections/post';

export default async function withoutBody(posts: Post[], outputPath: string) {
  const postsWithoutContent = posts.map(post => {
    return {
      ...post,
      content: undefined,
    };
  });
  const directory = path.join(outputPath, 'Post');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'withoutbody.json'), JSON.stringify(postsWithoutContent, null, 2), {
    encoding: 'utf8',
  });
}
