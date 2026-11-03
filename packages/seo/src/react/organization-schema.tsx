import type { Organization, WithContext } from 'schema-dts';

import type { OrganizationSchemaProps } from '../types.js';
import { JsonLdScript } from './json-ld-script.js';

/**
 * Organization schema for the homepage.
 * Helps Google understand your brand and display in knowledge panels.
 *
 * @see https://schema.org/Organization
 */
export function OrganizationSchema({
  siteName,
  siteUrl,
  siteDescription,
  authorName,
  logoPath = '/icon.png',
  sameAs = [],
}: OrganizationSchemaProps) {
  const data: WithContext<Organization> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: siteName,
    url: siteUrl,
    logo: `${siteUrl}${logoPath}`,
    description: siteDescription,
    sameAs,
    founder: {
      '@type': 'Person',
      name: authorName,
    },
  };

  return <JsonLdScript id="organization-schema" data={data} />;
}
