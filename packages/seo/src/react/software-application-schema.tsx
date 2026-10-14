import type { SoftwareApplication, WithContext } from 'schema-dts';

import type { SoftwareApplicationSchemaProps } from '../types';
import { JsonLdScript } from './json-ld-script';

/**
 * SoftwareApplication schema for web-based tools and applications.
 *
 * @see https://schema.org/SoftwareApplication
 */
export function SoftwareApplicationSchema({
  name,
  description,
  url,
  category,
  keywords,
  id,
  siteName,
  siteUrl,
}: SoftwareApplicationSchemaProps) {
  const fullUrl = url.startsWith('http') ? url : `${siteUrl}${url}`;

  const data: WithContext<SoftwareApplication> = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name,
    description,
    url: fullUrl,
    applicationCategory: category,
    operatingSystem: 'Web',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    provider: {
      '@type': 'Organization',
      name: siteName,
    },
    keywords: keywords?.join(', '),
  };

  return <JsonLdScript id={`software-app-schema-${id}`} data={data} />;
}
