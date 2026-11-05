# @arki/seo

SEO building blocks for web apps. Metadata, robots.txt, sitemap.xml and llms.txt builders. JSON-LD (schema.org) components. A TanStack Start head adapter.

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
