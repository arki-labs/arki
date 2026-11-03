/**
 * SEO structured data components for schema.org JSON-LD markup,
 * reusable UI components for FAQ and related items sections,
 * and SEO content sections. Metadata, robots, sitemap and llms.txt helpers are in `@arki/seo`.
 *
 * All schema components are Server Components that render `<script type="application/ld+json">` tags.
 * They accept explicit props for site identity — import from your app's `~/config`.
 *
 * @example
 * ```tsx
 * import { OrganizationSchema, WebSiteSchema, FAQSection } from '@arki/seo/react';
 * import config from '~/config';
 *
 * <OrganizationSchema
 *   siteName={config.appTitle}
 *   siteUrl={config.appLink}
 *   siteDescription={config.appDescription}
 *   authorName={config.appAuthor}
 * />
 * ```
 */

// JSON-LD Schema Components (Server Components)
export { ArticleSchema } from './article-schema.js';
export { BreadcrumbSchema } from './breadcrumb-schema.js';
export { FAQSchema } from './faq-schema.js';
export { HowToSchema } from './howto-schema.js';
export { ItemListSchema } from './item-list-schema.js';
export { JsonLdScript } from './json-ld-script.js';
export { OrganizationSchema } from './organization-schema.js';
export { SoftwareApplicationSchema } from './software-application-schema.js';
export { TechArticleSchema } from './tech-article-schema.js';
export { WebSiteSchema } from './website-schema.js';

// UI Components (Client Components)
export { FAQCompact, FAQSection } from './faq-section.js';
export { RelatedItems, RelatedItemsCompact } from './related-items.js';

// SEO Content Components (Server Components — no JS, fully rendered in HTML)
export { ActionableInsights } from './actionable-insights.js';
export { DeepDiveShowcase } from './deep-dive-showcase.js';
export { EducationalContent } from './educational-content.js';
export { ExampleShowcase } from './example-showcase.js';
export { FAQVisible } from './faq-visible.js';
export { ToolSEOContent } from './tool-seo-content.js';

export type { ToolSEOContentProps } from './tool-seo-content.js';
