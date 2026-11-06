# Agent guide: @arki/content-build

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/config.ts`, `src/presets.ts`, `src/vite.ts` and `src/cli.ts` win.

## The model

1. The app has a `content.config.ts` that exports a config made with `defineContentConfig`. The `marketing` preset holds `posts`, `legals`, `faqs` and `changelogs`.
2. The build reads the content files and writes `.content-collections/generated`. The app imports it as `content-collections`.
3. `contentPlugin` runs that build inside `vite build` and `vite dev`. `arki-content generate` runs the same build from the shell.
4. `arki-content snapshot` fetches the GitHub issues, pull requests and tweets that the content embeds, and writes them under `src/content/.embeds/`. The app commits them. The build reads them and never fetches.
5. `compileMarkdown` turns plain GitHub-flavoured markdown into `html` and `headings`. `compileMDX` is the MDX path for collections.
6. `@arki/content` reads the generated collections. `@arki/content-react` renders them.

## Task map

### Set up content in an app

1. In `content.config.ts`, export a config from `defineContentConfig`, or the `marketing` preset.
2. Add `contentPlugin()` to the Vite plugins.
3. Run `arki-content generate` before `tsc`, so a fresh clone type-checks.

### Compile GitHub markdown

1. `await compileMarkdown(document.content, { rewriteLink })` from `@arki/content-build/config`.
2. Use `html` and `headings`. Heading ids match GitHub's.
3. `rewriteLink(href)` returns a new `href`, `null` to drop the link and keep its text, or `undefined` to keep it.

### Embed a GitHub issue or a tweet

1. Write the embed in the content.
2. Run `arki-content snapshot` from the app folder.
3. Commit the files under `src/content/.embeds/`.

## Rules that bite

- Run from the folder that holds `content.config.ts`. Any other folder fails.
- `compileMarkdown` is not MDX. `<` and `{` in prose stay text.
- Raw HTML is sanitized (no `<script>`, no event handlers, no `javascript:` links). `trustedHtml: true` keeps it as written, only for markdown your team wrote.
- Run `arki-content snapshot` after adding an embed. A missing snapshot fails the build.
- The content builds once per process, even though Vite starts a build for each environment.
- `vite` is an optional peer. Only `@arki/content-build/vite` needs it.

## Errors

This package throws instead of returning failures. It has no error codes.

| Situation                                                  | Result                                                                                         | What to do                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A content file fails to read, parse, validate or transform | The build rejects with one line per file. `vite build` fails. `arki-content generate` exits 1. | Fix the file named in the message.                                          |
| A snapshot fetch fails                                     | `arki-content snapshot` prints `failed <url>` and exits 1.                                     | Check the URL and the network, then run it again.                           |
| Wrong usage or wrong folder                                | Exit 2 for a bad command. Exit 1 with a message for the wrong folder.                          | Run `arki-content generate` or `arki-content snapshot` from the app folder. |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
