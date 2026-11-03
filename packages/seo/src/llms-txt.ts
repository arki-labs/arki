type LlmsTxtItem = {
  title: string;
  url: string;
  description: string;
};

type LlmsTxtSection = {
  heading: string;
  items: LlmsTxtItem[];
};

type LlmsTxtInput = {
  /** Site/project name */
  name: string;
  /** Short tagline */
  tagline: string;
  /** Longer description paragraph */
  description: string;
  /** Grouped sections of links */
  sections: LlmsTxtSection[];
};

type LlmsFullTxtInput = LlmsTxtInput & {
  /** Additional detailed content per section or tool (keyed by section heading or item title) */
  details: Record<string, string>;
};

/**
 * Generates an llms.txt file content as a markdown string.
 *
 * The llms.txt convention provides LLM-friendly site descriptions,
 * helping AI models discover and understand site content.
 *
 * @see https://llmstxt.org/
 *
 * @example
 * ```ts
 * const content = generateLlmsTxt({
 *   name: 'Acme CSS',
 *   tagline: 'Free CSS tools in your browser',
 *   description: 'Free online CSS tools...',
 *   sections: [
 *     { heading: 'Tools', items: [{ title: 'Gradient Generator', url: '...', description: '...' }] },
 *   ],
 * });
 * ```
 */
export function generateLlmsTxt(input: LlmsTxtInput): string {
  const lines: string[] = [`# ${input.name}`, '', `> ${input.tagline}`, '', input.description, ''];

  for (const section of input.sections) {
    lines.push(`## ${section.heading}`, '');
    for (const item of section.items) {
      lines.push(`- [${item.title}](${item.url}): ${item.description}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

/**
 * Generates an extended llms-full.txt with additional detail sections.
 * Used for comprehensive AI model consumption with full capabilities listing.
 */
export function generateLlmsFullTxt(input: LlmsFullTxtInput): string {
  const lines: string[] = [`# ${input.name}`, '', `> ${input.tagline}`, '', input.description, ''];

  for (const section of input.sections) {
    lines.push(`## ${section.heading}`, '');

    for (const item of section.items) {
      lines.push(`### ${item.title}`, `URL: ${item.url}`, `Description: ${item.description}`);

      const detail = input.details[item.title];
      if (detail) {
        lines.push('', detail);
      }

      lines.push('');
    }
  }

  // Append any details that don't match section items (general info)
  const usedKeys = new Set(input.sections.flatMap(s => s.items.map(i => i.title)));
  for (const [key, detail] of Object.entries(input.details)) {
    if (!usedKeys.has(key)) {
      lines.push(`## ${key}`, '', detail, '');
    }
  }

  return lines.join('\n').trim() + '\n';
}
