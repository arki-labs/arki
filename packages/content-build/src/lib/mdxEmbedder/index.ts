import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Paragraph, Root } from 'mdast';
import type { Plugin } from 'unified';
import type { VFile } from 'vfile';

import { is, recordSchema } from '@arki/schema';
import type { Embed } from './embeds.js';
import { EMBEDS_FOLDER, findEmbeds, SNAPSHOT_SCRIPT, snapshotFile } from './embeds.js';
import { gitHubItemSchema } from './github/index.js';
import { tweetProps, tweetSnapshotSchema } from './twitter/index.js';
import { parseWith, replaceWithElement } from './utils.js';

/** The document's path inside its collection, as content-collections puts it on the file. */
function documentName(file: VFile): string {
  const meta = file.data['_meta'];
  return is(meta, recordSchema) && 'filePath' in meta && typeof meta.filePath === 'string'
    ? meta.filePath
    : 'an MDX document';
}

function render(paragraph: Paragraph, embed: Embed, snapshot: unknown, what: string): void {
  if (embed.kind === 'tweet') {
    replaceWithElement(paragraph, 'StaticTweet', { tweet: tweetProps(parseWith(tweetSnapshotSchema, snapshot, what)) });
    return;
  }
  const item = parseWith(gitHubItemSchema, snapshot, what);
  const repository = { owner: embed.owner, name: embed.repo };
  if (embed.kind === 'issue') replaceWithElement(paragraph, 'GitHubIssue', { issue: item, repository });
  else replaceWithElement(paragraph, 'GitHubPullRequest', { pullRequest: item, repository });
}

/**
 * Turns a paragraph that holds only a GitHub issue/PR or tweet URL into its embed card. The data comes from the
 * snapshot committed under `src/content/.embeds/` (written by `arki-content snapshot`): the build never fetches, and
 * a missing or broken snapshot fails it, naming the document, the URL and the command that fixes it.
 */
async function embedFromSnapshots(tree: Root, file: VFile): Promise<void> {
  const fix = `run \`cd ${process.cwd()} && bun run ${SNAPSHOT_SCRIPT}\` and commit ${EMBEDS_FOLDER}`;
  for (const { paragraph, embed } of findEmbeds(tree)) {
    const snapshot = path.join(EMBEDS_FOLDER, snapshotFile(embed));
    if (!existsSync(snapshot)) {
      throw new Error(`${documentName(file)}: embed ${embed.url} has no snapshot (${snapshot}); ${fix}`);
    }
    const what = `${documentName(file)}: snapshot ${snapshot} for ${embed.url} (to refresh it, ${fix})`;
    const data: unknown = JSON.parse(await readFile(snapshot, 'utf8'));
    render(paragraph, embed, data, what);
  }
}

const mdxEmbedder: Plugin<[], Root> = () => embedFromSnapshots;

export default mdxEmbedder;
