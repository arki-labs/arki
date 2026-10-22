/** Entry names that adapt to a platform or an optional peer (RFC `arki-structure` P3). */
export const ADAPTERS = new Set([
  'node',
  'browser',
  'react',
  'native',
  'react-native',
  'dot',
  'foreman',
  'drizzle',
  'otel',
  'testing',
  'tanstack-start',
  'orpc',
  'pg',
  'vite',
  'server',
  'cli',
  'zod',
  'tanstack',
  'sentry',
  'mastra',
  'http',
  'containers',
  'msw',
  'connections',
  'redis',
  'file',
  'eslint',
  'contract',
  'auth',
  'eval',
  'stdio',
  'openai',
  'transformers',
  'google',
  'mistral',
  'bedrock',
]);

/** True when the export subpath (`./react`, `./comparison/server`) is an adapter entry: its first segment is in {@link ADAPTERS}. */
export function isAdapterSubpath(subpath: string): boolean {
  return ADAPTERS.has(subpath.replace(/^\.\//, '').split('/')[0] ?? '');
}
