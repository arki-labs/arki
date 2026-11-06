# @arki/content-build

Build-time content pipeline for our apps: content-collections config, preset collections (posts, legal pages, FAQs, changelog) and the `arki-content` CLI.

## Install

```sh
bun add @arki/content-build
```

`vite` (7 or 8) is an optional peer. Only `@arki/content-build/vite` needs it.

## Quick start

Compile a markdown string to HTML and read its headings:

```ts
import { compileMarkdown } from '@arki/content-build/config';

const { html, headings } = await compileMarkdown('# Hello\n\nSome text.');

console.log(headings.map(heading => heading.text));
console.log(html.includes('<h1'));
```

Use the preset collections in the app's `content.config.ts`, and build them with the Vite plugin or the CLI:

```ts skip="fragment: lives in the app's content.config.ts and needs the app's content folders"
import { marketing } from '@arki/content-build/presets';

export default marketing;
```

```sh
arki-content generate
```

## When not to use this

- You need to read feeds, search posts or sort collections at run time. Use `@arki/content`.
- You need to render content in React. Use `@arki/content-react`.
- You need MDX for text with `<` and `{` in prose. Use `compileMarkdown`, which is plain markdown.

## Runtime support

<!-- runtimes:start -->

| Runtime | Result | Version tested | Date (UTC) |
| ------- | ------ | -------------- | ---------- |
| node    | pass   | v22.13.1       | 2026-11-05 |
| bun     | pass   | 1.4.2          | 2026-11-05 |
| deno    | pass   | 2.9.8          | 2026-11-05 |
| browser | n/a    | -              | 2026-11-05 |
| hermes  | n/a    | -              | 2026-11-05 |

<!-- runtimes:end -->

## Compiling plain markdown

`compileMarkdown` compiles GitHub-flavoured markdown to HTML. Use it for markdown written for GitHub, such as package READMEs and docs. MDX would fail on `<` and `{` in prose; plain markdown keeps them as text.

```ts skip="fragment: document comes from a content-collections transform"
import { compileMarkdown } from '@arki/content-build/config';

const { html, headings } = await compileMarkdown(document.content, {
  rewriteLink: href => (href.startsWith('./') ? `/docs/${href.slice(2).replace(/\.md$/, '')}` : undefined),
});
```

- `html`: the compiled page. Tables and task lists are kept. Raw HTML is sanitized with GitHub's rules (no `<script>`, no event handlers, no `javascript:` links). Pass `trustedHtml: true` to keep raw HTML as written, for markdown your own team wrote.
- `headings`: `{ depth, text, id }` for every heading, in order. Ids match GitHub's, so `#anchor` links keep working.
- Code blocks are highlighted by `rehype-pretty-code` with light and dark themes. Each token carries `--shiki-light` and `--shiki-dark` CSS variables; the app's CSS picks one.
- `rewriteLink(href)` runs on every link: return a new `href`, `null` to drop the link and keep its text, or `undefined` to keep it.

## Public imports

| Import                        | What                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/content-build/config`  | `defineContentConfig`, `defineCollection`, `compileMarkdown`, `compileMDX`, `addIdToHeadings`, `resolveImageBlurDataURL` and their types.               |
| `@arki/content-build/presets` | The collections `posts`, `legals`, `faqs`, `changelogs`, the `marketing` config that holds all four, and the types `Post`, `Legal`, `Faq`, `Changelog`. |
| `@arki/content-build/vite`    | `contentPlugin`, a Vite plugin that builds `content.config.ts` into `.content-collections/generated`.                                                   |
| `arki-content` (bin)          | `arki-content generate` builds the content. `arki-content snapshot` fetches the GitHub issues, pull requests and tweets that the content embeds.        |

## Failure behaviour

This is build tooling, so it throws instead of returning failures.

- A content file that fails to read, parse, validate or transform rejects the build with an error that lists one line per failing file. `vite build` fails on it. `vite dev` rebuilds on change and only logs it.
- `arki-content` exits 0 on success, 1 when a content file or a snapshot fetch failed, and 2 for wrong usage. It must run from the folder that holds `content.config.ts`.

## Limits

- `compileMarkdown` is plain GitHub-flavoured markdown. It is not MDX.
- Raw HTML in markdown is sanitized unless you pass `trustedHtml: true`.
- `arki-content snapshot` fetches embeds from the network. The build itself never fetches them. It reads the committed snapshots under `src/content/.embeds/`.
- The content builds once per process. The Vite plugin builds it once even though Vite starts a build for each environment.

## Documentation

- [Agent guide](docs/agent-guide.md): the model, the task map, the rules that bite, the errors and how to verify.
- [`llms.txt`](llms.txt): the short map an agent reads first.
- [`AGENTS.md`](AGENTS.md): the laws for changing this package.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, the Vite version and the failing content file.
