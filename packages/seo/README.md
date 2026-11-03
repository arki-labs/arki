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
