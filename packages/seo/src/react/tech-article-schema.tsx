import type { TechArticle, WithContext } from 'schema-dts';

import { JsonLdScript } from './json-ld-script';
import type { TechArticleSchemaProps } from '../types';

/**
 * TechArticle JSON-LD structured data for variant guide pages.
 *
 * Emits a TechArticle schema (subtype of Article) that signals to Google
 * the page is an educational technical article — not just a tool widget.
 * When stacked with SoftwareApplication and FAQPage schemas, it tells
 * search engines: "This page is a specialized calculator AND an educational
 * article AND a FAQ resource" — each opening different rich result opportunities.
 *
 * @see https://schema.org/TechArticle
 *
 * @example
 * ```tsx
 * <TechArticleSchema
 *   title="How Length Measurement Works"
 *   description="Everything about converting between metric and imperial length units."
 *   url="https://ekuation.com/unit-converter/length"
 *   articleMeta={{ datePublished: "2024-01-15", dateModified: "2024-06-01" }}
 *   siteName="Ekuation"
 *   siteUrl="https://ekuation.com"
 *   authorName="Ekuation"
 * />
 * ```
 */
export function TechArticleSchema({
  title,
  description,
  url,
  articleMeta,
  siteName,
  siteUrl,
  authorName,
}: TechArticleSchemaProps) {
  const data: WithContext<TechArticle> = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: title,
    description,
    url,
    datePublished: articleMeta.datePublished,
    dateModified: articleMeta.dateModified ?? articleMeta.datePublished,
    author: {
      '@type': 'Organization',
      name: authorName,
      url: siteUrl,
    },
    publisher: {
      '@type': 'Organization',
      name: siteName,
      url: siteUrl,
      logo: {
        '@type': 'ImageObject',
        url: `${siteUrl}/icon.png`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': url,
    },
  };

  return <JsonLdScript id={`tech-article-schema-${url.replaceAll('/', '-')}`} data={data} />;
}
