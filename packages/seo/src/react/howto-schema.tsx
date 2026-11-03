import type { HowTo, WithContext } from 'schema-dts';

import type { HowToSchemaProps } from '../types.js';
import { JsonLdScript } from './json-ld-script.js';

/**
 * HowTo schema for step-by-step guides.
 * Displays step-by-step instructions in search results.
 *
 * @see https://schema.org/HowTo
 */
export function HowToSchema({
  name,
  description,
  steps,
  totalTime,
}: HowToSchemaProps) {
  const data: WithContext<HowTo> = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name,
    description,
    totalTime,
    step: steps.map((step, index) => ({
      '@type': 'HowToStep' as const,
      position: index + 1,
      name: step.name,
      text: step.text,
      image: step.image,
    })),
  };

  return <JsonLdScript id="howto-schema" data={data} />;
}
