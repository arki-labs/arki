import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContentBuilder } from '../content-builder';
import { snapshotEmbeds } from './snapshot';

// The fixture lives inside the package so its config can import `@content-collections/core` from node_modules.
const cacheFolder = fileURLToPath(new URL('../../../.cache', import.meta.url));
const source = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// A posts collection that compiles MDX the way the presets do: remark-gfm, then the embedder.
const config = `
import { defineCollection, defineConfig } from '@content-collections/core';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';
import { compileMDX } from ${JSON.stringify(source('../compile-mdx.ts'))};
import mdxEmbedder from ${JSON.stringify(source('./index.ts'))};

const posts = defineCollection({
  name: 'posts',
  directory: 'src/content/posts',
  include: '*/index.mdx',
  schema: z.object({ title: z.string(), content: z.string() }),
  transform: async (post, context) => ({
    ...post,
    mdx: await compileMDX(context, post, { remarkPlugins: [remarkGfm, mdxEmbedder] }),
  }),
});

export default defineConfig({ content: [posts] });
`;

const tweetUrl = 'https://twitter.com/jack/status/20';
const issueUrl = 'https://github.com/acme/widgets/issues/7';
const post = `---\ntitle: Hello\n---\n\nIntro.\n\n${tweetUrl}\n\n${issueUrl}\n`;

const tweetSnapshot = {
  id_str: '20',
  text: 'just setting up my twttr',
  created_at: '2006-03-21T20:50:14.000Z',
  user: { name: 'jack', screen_name: 'jack', profile_image_url_https: 'https://pbs.twimg.com/jack.jpg' },
};
const issueSnapshot = {
  number: 7,
  url: issueUrl,
  titleHTML: 'Widgets wobble',
  createdAt: '2024-01-02T03:04:05Z',
  author: {
    login: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    url: 'https://github.com/octocat',
  },
};

const tweetFile = path.join('src', 'content', '.embeds', 'twitter', '20.json');
const issueFile = path.join('src', 'content', '.embeds', 'github', 'acme', 'widgets', 'issues', '7.json');

const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

/** What Twitter and GitHub answer, with fields the snapshot must drop. */
const answer = (url: string) => {
  if (url.startsWith('https://cdn.syndication.twimg.com/')) return { ...tweetSnapshot, favorite_count: 1 };
  return { data: { repository: { item: { ...issueSnapshot, state: 'OPEN' } } } };
};

describe('MDX embeds', () => {
  const startFolder = process.cwd();
  let app = '';

  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    writeFileSync(path.join(app, file), content);
  };
  const generated = () => {
    const folder = path.join(app, '.content-collections', 'generated');
    return readdirSync(folder)
      .map(file => readFileSync(path.join(folder, file), 'utf8'))
      .join('\n');
  };

  beforeEach(() => {
    mkdirSync(cacheFolder, { recursive: true });
    app = mkdtempSync(path.join(cacheFolder, 'embeds-'));
    write('content.config.ts', config);
    write(path.join('src', 'content', 'posts', 'hello', 'index.mdx'), post);
    process.chdir(app);
    // Nothing in a build may touch the network: any fetch fails the test.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('the build fetched')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.chdir(startFolder);
    rmSync(app, { recursive: true, force: true });
  });

  // WHY: builds used to fetch embeds, so a build depended on the network and on Twitter/GitHub answering the same way.
  // Now a missing snapshot must stop the build and say exactly how to create it.
  it('fails the build on an embed without a snapshot, naming the post, the URL and the command', async () => {
    write(issueFile, json(issueSnapshot));
    const content = await createContentBuilder(path.join(app, 'content.config.ts'));

    const failure = await content.build().then(
      () => 'built',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toContain('hello/index.mdx');
    expect(failure).toContain(tweetUrl);
    expect(failure).toContain(`cd ${app} && bun run content:snapshot`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renders embeds from their snapshots without the network', async () => {
    write(tweetFile, json(tweetSnapshot));
    write(issueFile, json(issueSnapshot));
    const content = await createContentBuilder(path.join(app, 'content.config.ts'));

    await expect(content.build()).resolves.toMatchObject({ documents: 1 });
    const output = generated();
    expect(output).toContain('StaticTweet');
    expect(output).toContain('just setting up my twttr');
    expect(output).toContain('GitHubIssue');
    expect(output).toContain('Widgets wobble');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails the build on a snapshot that does not match the schema', async () => {
    write(tweetFile, json({ id_str: '20' }));
    write(issueFile, json(issueSnapshot));
    const content = await createContentBuilder(path.join(app, 'content.config.ts'));

    await expect(content.build()).rejects.toThrow(tweetFile);
  });

  describe('snapshotEmbeds', () => {
    beforeEach(() => {
      vi.stubEnv('GITHUB_TOKEN', 'test-token');
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL) => Promise.resolve(Response.json(answer(String(input))))),
      );
    });

    // WHY: the snapshot is what every later build trusts, so only the checked fields may be written, and a snapshot
    // no post uses any more must go.
    it('writes one checked snapshot per embed and removes unused ones', async () => {
      const unused = path.join('src', 'content', '.embeds', 'twitter', '99.json');
      write(unused, json(tweetSnapshot));

      const report = await snapshotEmbeds(app);

      expect(report).toMatchObject({ embeds: 2, unchanged: 0, removed: [unused], failed: [] });
      expect(report.written.map(({ file }) => file).toSorted()).toEqual([issueFile, tweetFile].toSorted());
      expect(readFileSync(path.join(app, tweetFile), 'utf8')).toBe(json(tweetSnapshot));
      expect(readFileSync(path.join(app, issueFile), 'utf8')).toBe(json(issueSnapshot));
      expect(existsSync(path.join(app, unused))).toBe(false);

      // The snapshots it wrote are the ones the build reads.
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('the build fetched')));
      const content = await createContentBuilder(path.join(app, 'content.config.ts'));
      await expect(content.build()).resolves.toMatchObject({ documents: 1 });
    });

    it('rejects an answer that does not match the schema and writes nothing for it', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL) =>
          Promise.resolve(
            Response.json(String(input).includes('twimg') ? { __typename: 'TweetTombstone' } : answer('')),
          ),
        ),
      );

      const report = await snapshotEmbeds(app);

      expect(report.failed).toEqual([
        expect.objectContaining({
          url: tweetUrl,
          document: path.join('src', 'content', 'posts', 'hello', 'index.mdx'),
        }),
      ]);
      expect(report.failed[0]?.error).toContain('does not match the expected shape');
      expect(existsSync(path.join(app, tweetFile))).toBe(false);
      expect(existsSync(path.join(app, issueFile))).toBe(true);
    });
  });
});
