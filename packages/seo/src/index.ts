/**
 * Portable SEO helpers and types: tool metadata, robots.txt, sitemap.xml and llms.txt
 * builders. No React, no framework. Components live in `@arki/seo/react`, the
 * TanStack Start head adapter in `@arki/seo/tanstack-start`.
 *
 * @example
 * ```ts
 * import { createToolMetadata, renderRobotsTxt } from '@arki/seo';
 * ```
 */

// Metadata Helpers
export { createToolMetadata } from './metadata-helpers';

// Robots.txt Helpers
export { renderRobotsTxt, robotsTxtResponse } from './robots-helpers';
export type { RobotsTxtOptions } from './robots-helpers';

// Sitemap.xml Helpers
export {
  renderSitemapIndex,
  renderUrlset,
  sitemapIndexResponse,
  sitemapResponse,
} from './sitemap';
export type { ChangeFreq, SitemapEntry, SitemapIndexEntry } from './sitemap';

// LLM Discovery Utilities
export { generateLlmsFullTxt, generateLlmsTxt } from './llms-txt';

export type {
  ActionableInsightsData,
  ArticleData,
  ArticleMetaData,
  ArticleSchemaProps,
  BreadcrumbItem,
  BreadcrumbSchemaProps,
  CalculationStep,
  DeepDiveExample,
  EducationalSection,
  ExampleItem,
  FAQItem,
  FAQSchemaProps,
  FAQSectionProps,
  FAQVisibleProps,
  HowToSchemaProps,
  HowToStep,
  ItemListItem,
  ItemListSchemaProps,
  LlmsFullTxtInput,
  LlmsTxtInput,
  LlmsTxtItem,
  LlmsTxtSection,
  OrganizationSchemaProps,
  RelatedItem,
  SiteIdentityProps,
  SoftwareApplicationSchemaProps,
  TechArticleSchemaProps,
  WebSiteSchemaProps,
} from './types';
