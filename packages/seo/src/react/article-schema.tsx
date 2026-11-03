import type { Article, WithContext } from 'schema-dts';

import type { ArticleSchemaProps } from '../types.js';
import { JsonLdScript } from './json-ld-script.js';

/**
 * A date as ISO text, a string as given, or `undefined` for an Invalid Date: `toISOString()` throws
 * on it and would fail the whole page render, and both dates are optional in schema.org.
 */
function isoText(value: Date | string): string | undefined {
  if (!(value instanceof Date)) return value;
  return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
}

/**
 * Article schema for blog posts and content pages.
 * Displays article rich snippets with author and date.
 *
 * @see https://schema.org/Article
 */
export function ArticleSchema({ article, siteName, siteUrl }: ArticleSchemaProps) {
  const publishedDate = isoText(article.publishedAt);
  const modifiedDate = (article.modifiedAt ? isoText(article.modifiedAt) : undefined) ?? publishedDate;

  const fullUrl = article.url.startsWith('http') ? article.url : `${siteUrl}${article.url}`;

  const data: WithContext<Article> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    url: fullUrl,
    ...(publishedDate === undefined ? {} : { datePublished: publishedDate }),
    ...(modifiedDate === undefined ? {} : { dateModified: modifiedDate }),
    author: {
      '@type': 'Person',
      name: article.author.name,
      url: article.author.url,
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
      '@id': fullUrl,
    },
    image: article.image,
  };

  return <JsonLdScript id={`article-schema-${article.url.replaceAll('/', '-')}`} data={data} />;
}
