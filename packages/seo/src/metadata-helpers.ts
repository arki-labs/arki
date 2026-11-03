type ToolMetadataInput = {
  /** The tool/page title (without site suffix — Next.js template adds it) */
  title: string;
  /** Rich, keyword-aware description */
  description: string;
  /** URL path, e.g., '/gradient-generator' */
  path: string;
  /** Optional keywords for OG/Twitter metadata */
  keywords?: string[];
  /** Site name, e.g., 'Acme CSS' */
  siteName: string;
  /** Full site URL, e.g., 'https://example.com' */
  siteUrl: string;
};

/**
 * Creates consistent metadata for tool/app pages.
 * Generates title, description, canonical URL, OpenGraph, and Twitter card metadata.
 *
 * @example
 * ```ts
 * export const metadata = createToolMetadata({
 *   title: 'CSS Gradient Generator',
 *   description: 'Design beautiful CSS gradients...',
 *   path: '/gradient-generator',
 *   keywords: ['css gradient', 'gradient generator'],
 *   siteName: config.appTitle,
 *   siteUrl: config.appLink,
 * });
 * ```
 */
export function createToolMetadata({
  title,
  description,
  path,
  keywords,
  siteName,
  siteUrl,
}: ToolMetadataInput) {
  const url = `${siteUrl}${path}`;

  return {
    title,
    description,
    keywords,
    alternates: {
      canonical: path,
    },
    openGraph: {
      title: `${title} | ${siteName}`,
      description,
      url,
      type: 'website' as const,
    },
    twitter: {
      title: `${title} | ${siteName}`,
      description,
    },
  };
}
