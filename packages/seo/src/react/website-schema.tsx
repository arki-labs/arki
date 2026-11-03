import type { WebSite, WithContext } from 'schema-dts';

import type { WebSiteSchemaProps } from '../types.js';
import { JsonLdScript } from './json-ld-script.js';

/**
 * WebSite schema with optional SearchAction for sitelinks search box.
 *
 * The SearchAction includes Google's `query-input` extension which is not
 * part of the official schema.org spec (and therefore not in schema-dts types),
 * so we widen the type to accommodate it.
 *
 * @see https://schema.org/WebSite
 * @see https://developers.google.com/search/docs/appearance/structured-data/sitelinks-searchbox
 */
export function WebSiteSchema({
  siteName,
  siteUrl,
  siteDescription,
  searchUrlTemplate,
}: WebSiteSchemaProps) {
  const base: WithContext<WebSite> = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url: siteUrl,
    description: siteDescription,
  };

  // Google's sitelinks search box requires `query-input` on SearchAction,
  // which is a Google extension not in the schema.org spec / schema-dts types.
  const data = searchUrlTemplate
    ? {
        ...base,
        potentialAction: {
          '@type': 'SearchAction' as const,
          target: {
            '@type': 'EntryPoint' as const,
            urlTemplate: `${siteUrl}${searchUrlTemplate}`,
          },
          'query-input': 'required name=search_term_string',
        },
      }
    : base;

  return <JsonLdScript id="website-schema" data={data} />;
}
