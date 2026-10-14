import type { Article, WithContext } from 'schema-dts';

import type { ArticleSchemaProps } from '../types';
import { JsonLdScript } from './json-ld-script';

/**
 * Article schema for blog posts and content pages.
 * Displays article rich snippets with author and date.
 *
 * @see https://schema.org/Article
 */
export function ArticleSchema({ article, siteName, siteUrl }: ArticleSchemaProps) {
  const publishedDate =
    article.publishedAt instanceof Date
      ? article.publishedAt.toISOString()
      : article.publishedAt;
  const modifiedDate = article.modifiedAt
    ? article.modifiedAt instanceof Date
      ? article.modifiedAt.toISOString()
      : article.modifiedAt
    : publishedDate;

  const fullUrl = article.url.startsWith('http') ? article.url : `${siteUrl}${article.url}`;

  const data: WithContext<Article> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.description,
    url: fullUrl,
    datePublished: publishedDate,
    dateModified: modifiedDate,
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
