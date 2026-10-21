# @arki/content-build

Build-time content pipeline for our apps: content-collections config, preset collections (posts, legal pages, FAQs, changelog) and the `arki-content` CLI.

## Compiling plain markdown

`compileMarkdown` compiles GitHub-flavoured markdown to HTML. Use it for markdown written for GitHub, such as package READMEs and docs. MDX would fail on `<` and `{` in prose; plain markdown keeps them as text.

```ts
import { compileMarkdown } from '@arki/content-build/config';

const { html, headings } = await compileMarkdown(document.content, {
  rewriteLink: href => (href.startsWith('./') ? `/docs/${href.slice(2).replace(/\.md$/, '')}` : undefined),
});
```

- `html`: the compiled page. Tables, task lists and raw HTML are kept, so pass trusted input only.
- `headings`: `{ depth, text, id }` for every heading, in order. Ids match GitHub's, so `#anchor` links keep working.
- Code blocks are highlighted by `rehype-pretty-code` with light and dark themes. Each token carries `--shiki-light` and `--shiki-dark` CSS variables; the app's CSS picks one.
- `rewriteLink(href)` runs on every link: return a new `href`, `null` to drop the link and keep its text, or `undefined` to keep it.
