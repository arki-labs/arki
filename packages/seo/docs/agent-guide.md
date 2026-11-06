# Agent guide: @arki/seo

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/index.ts`, `src/react/` and `src/tanstack-start.ts` win.

## The model

1. `@arki/seo` is the portable entry: metadata, `robots.txt`, `sitemap.xml` and `llms.txt` builders. It has no React.
2. `@arki/seo/react` holds JSON-LD (schema.org) components and SEO content sections such as `FAQSection` and `ToolSEOContent`.
3. `@arki/seo/tanstack-start` has `Meta()`, which builds the `head().meta` array, and the `Head` and `Scripts` helpers.
4. `render*` functions return a string. `*Response` functions return a complete `Response` with a cache header.
5. The builders do not fetch or crawl. They format what you give them.

## Task map

### Serve robots.txt

1. `renderRobotsTxt({ baseUrl, disallow?, allowAiBots?, extraRules? })` returns the body.
2. `robotsTxtResponse(...)` returns a `Response` for the `/robots.txt` route, cached for one day by default.

### Serve a sitemap

1. `renderUrlset(entries)` with `{ url, lastModified, changeFrequency?, priority? }` for each page.
2. For more than 50,000 URLs, serve shards and `renderSitemapIndex(entries)` over them.
3. `sitemapResponse` and `sitemapIndexResponse` build the `Response`, cached for one hour by default.

### Write page metadata

1. `createToolMetadata(...)` gives the title, description, canonical URL, OpenGraph and Twitter card.
2. In TanStack Start, put `Meta({ title, description })` in the route's `head`.

### Add JSON-LD

1. `import { FAQSchema, OrganizationSchema } from '@arki/seo/react'`.
2. Render the schema component in the page. `JsonLdScript` renders any JSON-LD object.

### Write llms.txt for a site

1. `generateLlmsTxt(...)` builds the markdown. `generateLlmsFullTxt(...)` builds the longer file.

## Rules that bite

- The root entry has no React and no required peers.
- `./react` needs `react`, `@arki/ui`, `@arki/icons` and `@tanstack/react-router`. They are optional peers, so install them in the app.
- `Meta()` builds the `head().meta` array. Put it in the route's `head`.
- `renderRobotsTxt` blocks `/api/` and `/auth/` by default. Pass `disallow: []` to allow everything.
- `renderRobotsTxt` allows six AI crawlers by default. Pass `allowAiBots: []` to omit those rules.
- A sitemap entry takes a `Date`. An invalid one is listed without `<lastmod>`.
- One sitemap holds at most 50,000 URLs.

## Errors

This package has no error codes. The builders return strings and `Response` objects and do not return failures.

| Symptom                                   | Cause                                    | What to do                                                               |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| A sitemap entry has no `<lastmod>`        | Its `lastModified` is an invalid `Date`. | Pass a valid `Date`.                                                     |
| `@arki/seo/react` fails to resolve a peer | An optional peer is not installed.       | Install `react`, `@arki/ui`, `@arki/icons` and `@tanstack/react-router`. |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
