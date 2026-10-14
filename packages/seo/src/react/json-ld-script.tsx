import type { Thing, WithContext } from 'schema-dts';

/**
 * Renders JSON-LD structured data as an inline script element.
 *
 * Works with Next.js 16 Server Components and static generation.
 * Escapes `<` characters as `\u003c` to prevent XSS via script injection,
 * as recommended by the Next.js documentation.
 *
 * @see https://nextjs.org/docs/app/guides/json-ld
 *
 * Security: JSON.stringify safely serializes the data, and the `.replace(/</g, '\\u003c')`
 * prevents `</script>` sequences from breaking out of the JSON-LD block.
 * This is the approach recommended by the official Next.js docs for JSON-LD.
 * All data passed to these components comes from trusted internal sources (config, database records).
 *
 * @param id - Unique DOM id for the script tag
 * @param data - A schema.org JSON-LD object with @context
 */
export function JsonLdScript({ id, data }: { id: string; data: WithContext<Thing> }) {
  const jsonString = JSON.stringify(data).replace(/</g, '\\u003c');

  return (
    <script
      id={id}
      type="application/ld+json"
      // Safe: jsonString is produced by JSON.stringify + unicode escaping of '<'
      // This is the official Next.js pattern for JSON-LD structured data
      // See: https://nextjs.org/docs/app/guides/json-ld
      dangerouslySetInnerHTML={{ __html: jsonString }}
    />
  );
}
