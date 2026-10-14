/**
 * Versions the CLI reports and inlines into scaffolded apps.
 *
 * `@arki/dot` itself is read from this package's own `package.json`, so
 * `dot --version` and the scaffolded `@arki/dot` dependency always match
 * the installed CLI. It works from `src/cli/` (Bun, tests) and from
 * `dist/cli/` (published bin): both sit two levels below the package root.
 *
 * Every other `@arki/*` package a template depends on is pinned in
 * {@link TEMPLATE_VERSIONS}. A test in `new.test.ts` fails when one of these
 * falls behind the workspace `package.json` of that package, so a release
 * that bumps a dependency also has to refresh this table.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read `version` from `@arki/dot`'s own package.json. */
export function readDotVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '..', '..', 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
    return parsed.version;
  }
  throw new Error(`@arki/dot: no "version" field in ${manifestPath}`);
}

/**
 * Lowest published version of each `@arki/*` dependency the templates use.
 * Keys are the package names without the `@arki/` scope; the template
 * placeholder is `{{<camelCaseKey>Version}}` (see `new.ts`).
 */
export const TEMPLATE_VERSIONS = {
  env: '0.0.9',
  log: '0.1.0',
  db: '0.2.0',
  journal: '0.1.1',
  ui: '0.1.5',
  'design-systems': '0.1.2',
} as const;

/** Third-party versions the templates inline through a placeholder. */
export const ZOD_VERSION = '4.6.5';
