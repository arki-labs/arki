import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { getLogger } from '@arki/log';

import type { Embed } from './embeds.js';
import { changelogs } from '../../collections/changelog.js';
import { posts } from '../../collections/post.js';
import { EMBEDS_FOLDER, findEmbeds, snapshotFile } from './embeds.js';
import { fetchGitHubItem } from './github/index.js';
import { fetchTweet } from './twitter/index.js';

const logger = getLogger('arki:content');

/** The collections whose MDX runs the embedder. Every `.mdx` file in their folders is scanned. */
const embeddingCollections = [posts, changelogs];

/** content-collections hands the compiler the document without its front matter; the scan does the same. */
const frontMatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parses MDX the way the MDX compiler does before it runs the remark plugins (`remark-gfm` among them). */
const mdxParser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm);

/** What one `snapshot` run did. Paths are relative to the app folder. */
export type SnapshotReport = {
  /** Embeds found in the content, one per snapshot file. */
  embeds: number;
  written: { file: string; url: string }[];
  unchanged: number;
  removed: string[];
  failed: { url: string; document: string; error: string }[];
};

function parseMdx(body: string, document: string): Root {
  try {
    return mdxParser.parse(body);
  } catch (error) {
    throw new Error(`${document}: not valid MDX`, { cause: error });
  }
}

async function filesBelow(directory: string, extension: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(extension))
    .map(entry => path.join(entry.parentPath, entry.name))
    .toSorted();
}

/** Every embed in the app's content, keyed by snapshot file, with the first document that uses it. */
async function referencedEmbeds(root: string): Promise<Map<string, { embed: Embed; document: string }>> {
  const embeds = new Map<string, { embed: Embed; document: string }>();
  for (const collection of embeddingCollections) {
    for (const file of await filesBelow(path.join(root, collection.directory), '.mdx')) {
      const document = path.relative(root, file);
      const text = await readFile(file, 'utf8');
      const body = text.replace(frontMatter, '');
      for (const { embed } of findEmbeds(parseMdx(body, document))) {
        const snapshot = snapshotFile(embed);
        if (!embeds.has(snapshot)) embeds.set(snapshot, { embed, document });
      }
    }
  }
  return embeds;
}

const fetchSnapshot = (embed: Embed): Promise<object> =>
  embed.kind === 'tweet' ? fetchTweet(embed) : fetchGitHubItem(embed);

/**
 * Fetches every embed the app's content uses and writes its snapshot under `src/content/.embeds/`, each one checked
 * against the schema the build reads it with. Removes snapshots no document uses any more. A failed fetch keeps the
 * old snapshot and is listed in `failed`. `root` is the app folder.
 */
export async function snapshotEmbeds(root: string): Promise<SnapshotReport> {
  const folder = path.join(root, EMBEDS_FOLDER);
  const embeds = await referencedEmbeds(root);
  const report: SnapshotReport = { embeds: embeds.size, written: [], unchanged: 0, removed: [], failed: [] };

  for (const [file, { embed, document }] of embeds) {
    logger.debug('fetching {url} for {document}', { url: embed.url, document });
    let json: string;
    try {
      json = `${JSON.stringify(await fetchSnapshot(embed), null, 2)}\n`;
    } catch (error) {
      report.failed.push({ url: embed.url, document, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const target = path.join(folder, file);
    if (existsSync(target) && (await readFile(target, 'utf8')) === json) {
      report.unchanged += 1;
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, json);
    report.written.push({ file: path.relative(root, target), url: embed.url });
  }

  for (const target of await filesBelow(folder, '.json')) {
    if (embeds.has(path.relative(folder, target))) continue;
    await rm(target);
    report.removed.push(path.relative(root, target));
  }
  return report;
}
