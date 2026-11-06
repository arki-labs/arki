# @arki/seo

SEO building blocks for web apps. Metadata, robots.txt, sitemap.xml and llms.txt builders. JSON-LD (schema.org) components. A TanStack Start head adapter.

## Install

```sh
npm install @arki/seo
# or
bun add @arki/seo
# or
pnpm add @arki/seo
```

The root entry has no required peers. `@arki/seo/react` needs `react`, `react-dom`, `@arki/ui`, `@arki/icons` and `@tanstack/react-router`. `@arki/seo/tanstack-start` needs `react`. All are optional peers.

## Quick start

Build a `robots.txt` body and a sitemap from the root entry. It needs no React.

```ts
import { renderRobotsTxt, renderUrlset } from '@arki/seo';

export const robots = renderRobotsTxt({ baseUrl: 'https://pizzeria.example', disallow: ['/api/', '/auth/'] });

export const sitemap = renderUrlset([
  { url: 'https://pizzeria.example/', lastModified: new Date('2026-11-05'), changeFrequency: 'weekly', priority: 1 },
]);
```

`robotsTxtResponse` and `sitemapResponse` build a complete `Response` for a route.

## When not to use this

- You need a full CMS or an SEO audit tool. This package builds metadata, text files and JSON-LD. It does not crawl or score a site.
- You do not use React and need the JSON-LD components. Only `@arki/seo` (the root entry) works without React.
- You need one sitemap over 50,000 URLs. Split it into shards and use `renderSitemapIndex`.

## Runtime support

<!-- runtimes:start -->
| Runtime | Result | Version tested | Date (UTC) |
| --- | --- | --- | --- |
| node | pass | v22.13.1 | 2026-11-05 |
| bun | pass | 1.4.2 | 2026-11-05 |
| deno | pass | 2.9.8 | 2026-11-05 |
| browser | pass | Chromium 156.0.8078.4 | 2026-11-05 |
| hermes | pass | V1 250829098.0.17 | 2026-11-05 |

- `./react` runs on node, bun, deno, browser, hermes, bundled (bundler-only entry) (`scripts/smoke/react.mjs`).
<!-- runtimes:end -->

## Entries

| Entry | What | Needs |
| --- | --- | --- |
| `@arki/seo` | Portable builders and types: `createToolMetadata`, `renderRobotsTxt`, `renderUrlset`, `renderSitemapIndex`, `generateLlmsTxt` and the schema prop types. No React. | nothing |
| `@arki/seo/react` | JSON-LD components (`OrganizationSchema`, `FAQSchema`, `JsonLdScript`, ...) and SEO content sections (`ToolSEOContent`, `FAQSection`, `RelatedItems`, ...). | `react`, `@arki/ui`, `@arki/icons`, `@tanstack/react-router` (optional peers) |
| `@arki/seo/tanstack-start` | `Meta()` builds the `head().meta` array. `Head` and `Scripts` are small head helpers. | `react` (optional peer) |

## Example

```tsx skip="needs TanStack Router and a React app"
import { createToolMetadata } from '@arki/seo';
import { FAQSchema, OrganizationSchema } from '@arki/seo/react';
import { Meta } from '@arki/seo/tanstack-start';

export const Route = createFileRoute('/')({
  head: () => ({ meta: Meta({ title: 'Analytical Pizza', description: 'Pizza, computed. Ovens open at noon.' }) }),
});
```

## Public imports

| Import                     | What it holds                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@arki/seo`                | `createToolMetadata`, `generateLlmsTxt`, `generateLlmsFullTxt`, `renderRobotsTxt`, `robotsTxtResponse`, `renderUrlset`, `renderSitemapIndex`, `sitemapResponse`, `sitemapIndexResponse` and the types. |
| `@arki/seo/react`          | The JSON-LD schema components, `JsonLdScript` and the SEO content sections.                                    |
| `@arki/seo/tanstack-start` | `Meta`, `Head`, `Scripts`.                                                                                      |

[`docs/api.md`](docs/api.md) lists every exported value.

## Failure behaviour

The builders return strings and `Response` objects. They define no failure codes and do not return failures. A sitemap entry with an invalid `Date` is listed without `<lastmod>`, so one bad entry does not fail the whole sitemap. `JsonLdScript` escapes `<` so the data cannot close the script tag.

## Observability

Renders in the app's own process and does no I/O of its own, so the app's spans cover it and the package adds none.

## Limits

- One sitemap holds at most 50,000 URLs (the Google limit). `renderSitemapIndex` points at shard sitemaps.
- `robotsTxtResponse` caches for one day by default. `sitemapResponse` caches for one hour by default.
- `renderRobotsTxt` blocks `/api/` and `/auth/` for every crawler by default, and allows six AI crawlers by default. Pass `disallow` or `allowAiBots` to change them.
- The `Scripts` component of `./tanstack-start` is a placeholder. TanStack Start injects scripts itself.

## Documentation

- [API reference](docs/api.md): every exported value, by import path.
- [Agent guide](docs/agent-guide.md): the model, the task map, the rules and the errors.
- [llms.txt](llms.txt): the import map for agents.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version and the runtime.
