// Speed of a full content build: `@arki/content-build` against Velite and contentlayer2.
// Run: `bun run bench --timeout 600000` (explore) or
// `bun run bench --profile publish --timeout 600000 --write-readme` (idle machine only).
//
// Every contender builds the same generated MDX posts through its real command-line program, in a child process,
// the way a project builds its content: `arki-content generate`, `velite build`, `contentlayer2 build`. Each one
// reads the files, parses the frontmatter, validates it with a schema, compiles the MDX body (with GitHub
// Flavored Markdown) to a function-body string and writes every document to disk. The contract check reads that
// output and compares it with what the fixture generator wrote, before anything is timed.
//
// Scenarios:
// - cold: a new project folder for every build, so no contender has a cache (and the config is bundled again).
// - cached: the same project folder again after a finished build, with no change.
// - one-file change: one post's body changes before every build, in a project folder that has built before.

import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { compare, defineSuite } from '@arki/bench';
import { z } from '@arki/contracts';

const execFile = promisify(execFileCallback);
const requireFromSuite = createRequire(import.meta.url);
const packageFolder = fileURLToPath(new URL('..', import.meta.url));

// Inside the package, so every generated config resolves its imports from this package's node_modules.
const fixtureFolder = path.join(packageFolder, '.cache', `bench-${process.pid}`);
rmSync(fixtureFolder, { recursive: true, force: true });
mkdirSync(fixtureFolder, { recursive: true });
process.once('exit', () => rmSync(fixtureFolder, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Fixture: N deterministic posts, the same files for every contender
// ---------------------------------------------------------------------------

const topics = ['caching', 'testing', 'routing', 'databases', 'logging', 'deployments', 'type safety', 'forms'];
const tagPool = ['typescript', 'react', 'node', 'performance', 'tooling', 'testing', 'css', 'release'];
const authors = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson'];
const firstDay = Date.UTC(2024, 0, 1);

type PostFrontmatter = {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  tags: string[];
  author: string;
};

function frontmatterOf(index: number): PostFrontmatter {
  const slug = `post-${String(index).padStart(4, '0')}`;
  const topic = topics[index % topics.length] ?? 'notes';
  return {
    slug,
    title: `Post ${index}: notes on ${topic}`,
    description: `What we learned about ${topic} while building post number ${index}.`,
    publishedAt: new Date(firstDay + index * 86_400_000).toISOString(),
    tags: [tagPool[index % tagPool.length] ?? 'misc', tagPool[(index * 3 + 1) % tagPool.length] ?? 'misc'],
    author: authors[index % authors.length] ?? 'Anonymous',
  };
}

/** A text every compiled body must contain: it sits at the very end, so only a fully compiled body has it. */
const sentinelOf = (slug: string): string => `Sentinel ${slug} end.`;

/** One post's file. `revision` only changes a body line, for the one-file change scenario. */
function postSource(index: number, revision: number): string {
  const { slug, title, description, publishedAt, tags, author } = frontmatterOf(index);
  const topic = topics[index % topics.length] ?? 'notes';
  // JSON strings are valid YAML strings, so every value is quoted the same way for every parser.
  const frontmatter = [
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `publishedAt: ${JSON.stringify(publishedAt)}`,
    `tags: ${JSON.stringify(tags)}`,
    `author: ${JSON.stringify(author)}`,
  ].join('\n');
  const paragraph = (n: number): string =>
    `Paragraph ${n} about ${topic}. We measured the slow parts first, then changed one thing at a time and kept ` +
    `notes on every result, so the next person can repeat the steps for post ${index} without guessing.`;
  return `---
${frontmatter}
---

## Why ${topic} matters

${paragraph(1)} Read the [full guide](https://example.com/guides/${slug}) for **more detail** and _context_.

${paragraph(2)}

### What we tried

- Measure before changing anything
- Change one setting at a time
- Write down every result

| Step | Result |
| ---- | ------ |
| ${index} | kept |

\`\`\`ts
export function score(values: readonly number[]): number {
  return values.reduce((total, value) => total + value * ${index}, 0);
}
\`\`\`

<aside data-kind="note">A short note for post {${index}}: keep the steps small.</aside>

## Results

${paragraph(3)}

${paragraph(4)}

Revision ${revision}.

${sentinelOf(slug)}
`;
}

const contentFolders = new Map<number, string>();

/** The shared, read-only posts folder for `count` posts (written once per process, before any timing). */
function contentFolder(count: number): string {
  const existing = contentFolders.get(count);
  if (existing !== undefined) return existing;
  const folder = path.join(fixtureFolder, `content-${count}`);
  mkdirSync(folder, { recursive: true });
  for (let index = 1; index <= count; index++) {
    writeFileSync(path.join(folder, `${frontmatterOf(index).slug}.mdx`), postSource(index, 0));
  }
  contentFolders.set(count, folder);
  return folder;
}

// ---------------------------------------------------------------------------
// Contract: what every contender's output must hold
// ---------------------------------------------------------------------------

type BuiltPost = PostFrontmatter & { compiled: boolean };

/** The oracle: every post the generator wrote, sorted by slug, with a fully compiled body. */
function expectedPosts(count: number): BuiltPost[] {
  return Array.from({ length: count }, (_, offset) => ({ ...frontmatterOf(offset + 1), compiled: true }));
}

const isoDate = z.union([z.string(), z.date()]).transform(value => new Date(value).toISOString());

function builtPost(filePath: string, fields: Omit<PostFrontmatter, 'slug'>, code: string): BuiltPost {
  const slug = path.posix.basename(filePath).replace(/\.mdx$/, '');
  return { slug, ...fields, compiled: code.length > 0 && code.includes(sentinelOf(slug)) };
}

const bySlug = (posts: BuiltPost[]): BuiltPost[] => posts.toSorted((a, b) => a.slug.localeCompare(b.slug));

const frontmatterFields = {
  title: z.string(),
  description: z.string(),
  publishedAt: isoDate,
  tags: z.array(z.string()),
  author: z.string(),
};

const arkiOutput = z.array(z.object({ ...frontmatterFields, _meta: z.object({ path: z.string() }), code: z.string() }));
const veliteOutput = z.array(z.object({ ...frontmatterFields, path: z.string(), code: z.string() }));
const contentlayerOutput = z.array(
  z.object({
    ...frontmatterFields,
    _raw: z.object({ flattenedPath: z.string() }),
    body: z.object({ code: z.string() }),
  }),
);

let importRevision = 0;

// ---------------------------------------------------------------------------
// Contenders
// ---------------------------------------------------------------------------

type Contender = {
  label: string;
  package: string;
  configFile: string;
  /** The project's config file; `content` is the posts folder, relative to the project folder. */
  config: (content: string) => string;
  /** The program and its arguments, run with the project folder as the current folder. */
  command: readonly string[];
  /** Reads the documents the build wrote. Untimed. */
  read: (project: string) => Promise<BuiltPost[]>;
};

const manifestBin = z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]) });

function binOf(name: string): string {
  const manifest = requireFromSuite.resolve(`${name}/package.json`);
  const { bin } = manifestBin.parse(JSON.parse(readFileSync(manifest, 'utf8')));
  const relative = typeof bin === 'string' ? bin : bin[name];
  if (relative === undefined) throw new Error(`${name} declares no "${name}" program`);
  return path.join(path.dirname(manifest), relative);
}

const contenders = {
  arki: {
    label: '@arki/content-build',
    package: '@arki/content-build',
    configFile: 'content.config.ts',
    config: content => `import { compileMDX, defineCollection, defineContentConfig } from '@arki/content-build/config';
import { z } from '@arki/contracts';
import remarkGfm from 'remark-gfm';

const posts = defineCollection({
  name: 'posts',
  directory: ${JSON.stringify(content)},
  include: '*.mdx',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    publishedAt: z.coerce.date(),
    tags: z.array(z.string()),
    author: z.string(),
    content: z.string(),
  }),
  transform: async (post, context) => ({ ...post, code: await compileMDX(context, post, { remarkPlugins: [remarkGfm] }) }),
});

export default defineContentConfig({ content: [posts] });
`,
    command: [path.join(packageFolder, 'dist', 'src', 'cli.js'), 'generate'],
    read: async project => {
      importRevision += 1;
      const generated = pathToFileURL(path.join(project, '.content-collections', 'generated', 'allPosts.js'));
      const module: unknown = await import(`${generated.href}?revision=${importRevision}`);
      const documents = arkiOutput.parse(z.object({ default: z.unknown() }).parse(module).default);
      return bySlug(documents.map(({ _meta, code, ...fields }) => builtPost(_meta.path, fields, code)));
    },
  },
  velite: {
    label: 'Velite',
    package: 'velite',
    configFile: 'velite.config.ts',
    config: content => `import { defineConfig, s } from 'velite';

export default defineConfig({
  root: ${JSON.stringify(content)},
  strict: true,
  output: { data: '.velite', assets: 'public/static', base: '/static/', name: '[name]-[hash:6].[ext]', clean: false },
  collections: {
    posts: {
      name: 'Post',
      pattern: '*.mdx',
      schema: s.object({
        path: s.path(),
        title: s.string(),
        description: s.string(),
        publishedAt: s.isodate(),
        tags: s.array(s.string()),
        author: s.string(),
        content: s.raw(),
        code: s.mdx(),
      }),
    },
  },
});
`,
    command: [binOf('velite'), 'build'],
    read: async project => {
      const documents = veliteOutput.parse(
        JSON.parse(await readFile(path.join(project, '.velite', 'posts.json'), 'utf8')),
      );
      return bySlug(documents.map(({ path: filePath, code, ...fields }) => builtPost(filePath, fields, code)));
    },
  },
  contentlayer: {
    label: 'contentlayer2',
    package: 'contentlayer2',
    configFile: 'contentlayer.config.ts',
    config: content => `import { defineDocumentType, makeSource } from 'contentlayer2/source-files';
import remarkGfm from 'remark-gfm';

const Post = defineDocumentType(() => ({
  name: 'Post',
  filePathPattern: '*.mdx',
  contentType: 'mdx',
  fields: {
    title: { type: 'string', required: true },
    description: { type: 'string', required: true },
    publishedAt: { type: 'date', required: true },
    tags: { type: 'list', of: { type: 'string' }, required: true },
    author: { type: 'string', required: true },
  },
}));

export default makeSource({
  contentDirPath: ${JSON.stringify(content)},
  documentTypes: [Post],
  mdx: { remarkPlugins: [remarkGfm] },
  disableImportAliasWarning: true,
});
`,
    command: [binOf('contentlayer2'), 'build'],
    read: async project => {
      const index = path.join(project, '.contentlayer', 'generated', 'Post', '_index.json');
      const documents = contentlayerOutput.parse(JSON.parse(await readFile(index, 'utf8')));
      return bySlug(documents.map(({ _raw, body, ...fields }) => builtPost(_raw.flattenedPath, fields, body.code)));
    },
  },
} satisfies Record<string, Contender>;

/** Writes a project folder: only the contender's config, pointing at `content`. */
function createProject(contender: Contender, parent: string, content: string): string {
  const project = mkdtempSync(path.join(parent, 'project-'));
  writeFileSync(path.join(project, contender.configFile), contender.config(path.relative(project, content)));
  return project;
}

// contentlayer2 reads the current folder from PWD, like a shell sets it; set it for every contender alike.
const buildOptions = (project: string) => ({
  cwd: project,
  env: { ...process.env, PWD: project },
  maxBuffer: 64 * 1024 * 1024,
});

/** One build, timed: the contender's program in a child process. */
async function build(contender: Contender, project: string): Promise<string> {
  const [program, ...args] = contender.command;
  if (program === undefined) throw new Error(`${contender.label} has no command`);
  await execFile(process.execPath, [program, ...args], buildOptions(project));
  return project;
}

/** The same build, untimed, to give a project its caches before the cached scenarios. */
function buildSync(contender: Contender, project: string): void {
  execFileSync(process.execPath, [...contender.command], { ...buildOptions(project), stdio: 'ignore' });
}

const stateFolder = (count: number): string => mkdtempSync(path.join(fixtureFolder, `n${count}-state-`));

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const contract = {
  id: 'content-build-output/v1',
  description:
    'every generated post, once: slug, title, description, publishedAt (ISO), tags and author equal to the file, and a non-empty compiled MDX string that holds the whole body',
};

function coldGroup(count: number) {
  return compare<number>({
    id: `n${count}-cold`,
    title: `Cold build, ${count} MDX posts`,
    contract,
    inputs: [count],
    expected: expectedPosts,
    baseline: 'arki',
    mode: 'async',
    note: 'A new project folder for every build: no cache, and the config is bundled again.',
    cases: c =>
      Object.fromEntries(
        Object.entries(contenders).map(([key, contender]) => [
          key,
          c({
            label: contender.label,
            package: contender.package,
            setup: posts => ({ parent: stateFolder(posts), content: contentFolder(posts) }),
            run: async ({ parent, content }) => build(contender, createProject(contender, parent, content)),
            normalize: project => contender.read(project),
            teardown: ({ parent }) => rmSync(parent, { recursive: true, force: true }),
          }),
        ]),
      ),
  });
}

function cachedGroup(count: number) {
  return compare<number>({
    id: `n${count}-cached`,
    title: `Rebuild with no change, ${count} MDX posts`,
    contract,
    inputs: [count],
    expected: expectedPosts,
    baseline: 'arki',
    mode: 'async',
    note: 'The same project folder after a finished build; each contender uses whatever cache it keeps on disk.',
    cases: c =>
      Object.fromEntries(
        Object.entries(contenders).map(([key, contender]) => [
          key,
          c({
            label: contender.label,
            package: contender.package,
            setup: posts => {
              const parent = stateFolder(posts);
              const project = createProject(contender, parent, contentFolder(posts));
              buildSync(contender, project);
              return { parent, project };
            },
            run: async ({ project }) => build(contender, project),
            normalize: project => contender.read(project),
            teardown: ({ parent }) => rmSync(parent, { recursive: true, force: true }),
          }),
        ]),
      ),
  });
}

function editGroup(count: number) {
  return compare<number>({
    id: `n${count}-one-file-change`,
    title: `Rebuild after one post changed, ${count} MDX posts`,
    contract,
    inputs: [count],
    expected: expectedPosts,
    baseline: 'arki',
    mode: 'async',
    note: "The first post's body gets a new revision line before every build; each contender has its own copy of the posts.",
    cases: c =>
      Object.fromEntries(
        Object.entries(contenders).map(([key, contender]) => [
          key,
          c({
            label: contender.label,
            package: contender.package,
            setup: posts => {
              const parent = stateFolder(posts);
              const content = path.join(parent, 'content');
              cpSync(contentFolder(posts), content, { recursive: true });
              const project = createProject(contender, parent, content);
              buildSync(contender, project);
              return { parent, project, edited: path.join(content, `${frontmatterOf(1).slug}.mdx`), revision: 0 };
            },
            run: async state => {
              state.revision += 1;
              writeFileSync(state.edited, postSource(1, state.revision));
              return build(contender, state.project);
            },
            normalize: project => contender.read(project),
            teardown: ({ parent }) => rmSync(parent, { recursive: true, force: true }),
          }),
        ]),
      ),
  });
}

export default defineSuite({
  id: '@arki/content-build',
  intro:
    'Time to build generated MDX blog posts with `@arki/content-build`, Velite and contentlayer2, each through its own command-line program. Each table only ranks tools whose output held every post with the right frontmatter and a fully compiled body.',
  notes: [
    'Every contender parses the frontmatter, validates it with a schema, compiles MDX with GitHub Flavored Markdown to a minified function-body string and writes all documents (with the raw body) to disk.',
    'Each build runs in a new child process, so the times include starting the program and bundling its config: what a project pays when it runs the build command.',
    '`@arki/content-build` and contentlayer2 compile MDX with mdx-bundler (esbuild); Velite compiles with @mdx-js/mdx and minifies with esbuild.',
    'contentlayer2 also writes one JSON file per document; Velite keeps no cache between runs, so its rebuilds do the whole build again.',
    'The `posts` preset of `@arki/content-build` (Code Hike, images, git dates) does more work and is not compared here.',
  ],
  groups: [100, 1000].flatMap(count => [coldGroup(count), cachedGroup(count), editGroup(count)]),
});
