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
export { ArticleSchema } from './article-schema';
export { BreadcrumbSchema } from './breadcrumb-schema';
export { FAQSchema } from './faq-schema';
export { HowToSchema } from './howto-schema';
export { ItemListSchema } from './item-list-schema';
export { JsonLdScript } from './json-ld-script';
export { OrganizationSchema } from './organization-schema';
export { SoftwareApplicationSchema } from './software-application-schema';
export { TechArticleSchema } from './tech-article-schema';
export { WebSiteSchema } from './website-schema';

// UI Components (Client Components)
export { FAQCompact, FAQSection } from './faq-section';
export { RelatedItems, RelatedItemsCompact } from './related-items';

// SEO Content Components (Server Components — no JS, fully rendered in HTML)
export { ActionableInsights } from './actionable-insights';
export { DeepDiveShowcase } from './deep-dive-showcase';
export { EducationalContent } from './educational-content';
export { ExampleShowcase } from './example-showcase';
export { FAQVisible } from './faq-visible';
export { ToolSEOContent } from './tool-seo-content';

export type { ToolSEOContentProps } from './tool-seo-content';
