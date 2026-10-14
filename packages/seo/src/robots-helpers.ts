/**
 * Framework-agnostic robots.txt builder.
 *
 * Apps invoke `robotsTxtResponse({ baseUrl, ... })` from a server handler
 * (TanStack Start route, Hono handler, plain Node) and return the resulting
 * `Response` directly.
 *
 * Crawlers parse robots.txt by content, not URL extension, so the builder is
 * decoupled from the routing framework.
 */

const DEFAULT_AI_BOTS = [
  'GPTBot', // OpenAI
  'ClaudeBot', // Anthropic
  'PerplexityBot',
  'Applebot',
  'Bingbot',
  'Google-Extended',
] as const;

const DEFAULT_DISALLOW = ['/api/', '/auth/'] as const;

const DEFAULT_CACHE_SECONDS = 86_400; // 1 day

export type RobotsTxtOptions = {
  /** Absolute base URL of the site, used to build the `Sitemap:` line. */
  baseUrl: string;
  /** Path of the sitemap relative to `baseUrl`. Defaults to `/sitemap.xml`. */
  sitemapPath?: string;
  /**
   * Paths blocked for the wildcard `*` user-agent. Defaults to `['/api/', '/auth/']`.
   * Pass `[]` to allow everything.
   */
  disallow?: readonly string[];
  /**
   * AI crawler user-agents to explicitly allow with their own permissive rule.
   * Defaults to GPTBot, ClaudeBot, PerplexityBot, Applebot, Bingbot, Google-Extended.
   * Pass `[]` to omit AI-specific rules entirely (e.g. for apps that should not be
   * indexed by AI), or pass a custom list.
   */
  allowAiBots?: readonly string[];
  /** Extra rule blocks appended verbatim after the default rules. */
  extraRules?: readonly string[];
};

/**
 * Builds the body of a robots.txt file.
 *
 * @example
 * ```ts
 * renderRobotsTxt({
 *   baseUrl: 'https://example.com',
 *   disallow: ['/api/', '/auth/', '/debug/'],
 * });
 * ```
 */
export function renderRobotsTxt(options: RobotsTxtOptions): string {
  const sitemapPath = options.sitemapPath ?? '/sitemap.xml';
  const disallow = options.disallow ?? DEFAULT_DISALLOW;
  const allowAiBots = options.allowAiBots ?? DEFAULT_AI_BOTS;

  const lines: string[] = ['User-agent: *', 'Allow: /'];
  for (const path of disallow) {
    lines.push(`Disallow: ${path}`);
  }

  for (const bot of allowAiBots) {
    lines.push('', `User-agent: ${bot}`, 'Allow: /');
  }

  if (options.extraRules?.length) {
    for (const rule of options.extraRules) {
      lines.push('', rule);
    }
  }

  lines.push('', `Sitemap: ${options.baseUrl}${sitemapPath}`);

  return lines.join('\n') + '\n';
}

/**
 * Builds a complete `Response` for a `/robots.txt` route.
 * Sets `Content-Type: text/plain; charset=utf-8` and a 1-day cache by default.
 */
export function robotsTxtResponse(
  options: RobotsTxtOptions & { cacheSeconds?: number },
): Response {
  const cacheSeconds = options.cacheSeconds ?? DEFAULT_CACHE_SECONDS;

  return new Response(renderRobotsTxt(options), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`,
    },
  });
}
