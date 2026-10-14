import type { FAQPage, WithContext } from 'schema-dts';

import type { FAQSchemaProps } from '../types';
import { JsonLdScript } from './json-ld-script';

/**
 * FAQPage schema for FAQ sections.
 * Displays FAQ accordion in search results.
 *
 * @see https://schema.org/FAQPage
 */
export function FAQSchema({ faqs }: FAQSchemaProps) {
  if (faqs.length === 0) return null;

  const data: WithContext<FAQPage> = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question' as const,
      name: faq.question,
      ...(faq.datePublished && { datePublished: faq.datePublished }),
      ...(faq.dateModified && { dateModified: faq.dateModified }),
      acceptedAnswer: {
        '@type': 'Answer' as const,
        text: faq.answer,
      },
    })),
  };

  return <JsonLdScript id="faq-schema" data={data} />;
}
