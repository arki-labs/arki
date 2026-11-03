import type { ItemList, WithContext } from 'schema-dts';

import type { ItemListSchemaProps } from '../types.js';
import { JsonLdScript } from './json-ld-script.js';

/**
 * ItemList schema for category pages listing multiple items.
 *
 * @see https://schema.org/ItemList
 */
export function ItemListSchema({
  name,
  description,
  items,
  id,
  siteUrl,
}: ItemListSchemaProps) {
  const data: WithContext<ItemList> = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    description,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem' as const,
      position: index + 1,
      name: item.name,
      url: item.url.startsWith('http') ? item.url : `${siteUrl}${item.url}`,
      description: item.description,
    })),
  };

  return <JsonLdScript id={`item-list-schema-${id}`} data={data} />;
}
