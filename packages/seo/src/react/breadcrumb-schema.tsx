import type { BreadcrumbList, WithContext } from 'schema-dts';

import type { BreadcrumbSchemaProps } from '../types';
import { JsonLdScript } from './json-ld-script';

/**
 * BreadcrumbList schema for navigation breadcrumbs.
 * Displays breadcrumb trail in search results.
 *
 * @see https://schema.org/BreadcrumbList
 */
export function BreadcrumbSchema({ items, siteUrl }: BreadcrumbSchemaProps) {
  const data: WithContext<BreadcrumbList> = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem' as const,
      position: index + 1,
      name: item.label,
      item: item.href.startsWith('http') ? item.href : `${siteUrl}${item.href}`,
    })),
  };

  return <JsonLdScript id="breadcrumb-schema" data={data} />;
}
