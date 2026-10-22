/**
 * `@arki/icons/vite` — Phosphor icons compiled to one module per icon.
 *
 * `import { Heart } from '@arki/icons/phosphor'` reads the whole Phosphor
 * index (1,500 icons, 6.5 MB of source) to get one component. The browser
 * bundle tree-shakes it away; the server does not: the index is externalized
 * and Bun evaluates all of it at cold start (about 300 ms), or Rolldown inlines
 * all of it. This plugin rewrites every named icon import, at build time, to
 * the icon's own module (`@phosphor-icons/react/dist/csr/Heart`), which is what
 * the index re-exports anyway. Same components, same `IconContext`, same
 * public API for the app; the server loads only the icons it renders.
 *
 * ```ts
 * import { phosphorPerIcon } from '@arki/icons/vite';
 * plugins: [phosphorPerIcon()]
 * ```
 *
 * Rewritten: named imports from `@arki/icons/phosphor` and
 * `@phosphor-icons/react` whose name is an icon (`Heart`, `HeartIcon`) or
 * `IconContext`. Left where they are: type names and anything else, and
 * `import type` specifiers. The replacement keeps the statement's line count,
 * so line numbers in stack traces and source maps hold.
 *
 * `vite` is an optional peer; import this module from a Vite config only.
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';

const PHOSPHOR = '@phosphor-icons/react';
const ICON_MODULE_SUFFIX = '.es.js';

/**
 * One `import { … } from '<source>'` statement for either source, any quote
 * style, braces spanning any number of lines. Default and namespace imports
 * are not in use for these modules and stay untouched.
 */
const ICON_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])(@arki\/icons\/phosphor|@phosphor-icons\/react)\2\s*;?/g;

/** Every icon that has its own module under `dist/csr`, by base name (`Heart`, not `HeartIcon`). */
export function phosphorIconNames(): ReadonlySet<string> {
  const packageJson = createRequire(import.meta.url).resolve(`${PHOSPHOR}/package.json`);
  const files = readdirSync(path.join(path.dirname(packageJson), 'dist', 'csr'));
  return new Set(
    files.filter(file => file.endsWith(ICON_MODULE_SUFFIX)).map(file => file.slice(0, -ICON_MODULE_SUFFIX.length)),
  );
}

/** `Heart` and `HeartIcon` both live in `dist/csr/Heart`; anything else has no icon module. */
function iconModuleOf(name: string, icons: ReadonlySet<string>): string | undefined {
  if (icons.has(name)) return name;
  const base = name.endsWith('Icon') ? name.slice(0, -'Icon'.length) : '';
  return icons.has(base) ? base : undefined;
}

/** The imported name of a specifier: `Heart as H` → `Heart`. */
function importedNameOf(specifier: string): string {
  return specifier.replace(/\s+as\s+[\w$]+$/, '');
}

/**
 * Rewrite the icon imports of one module. Pure: the same code and icon set
 * give the same output, and code without icon imports comes back unchanged.
 */
export function rewriteIconImports(code: string, icons: ReadonlySet<string>): string {
  return code.replaceAll(ICON_IMPORT, (statement: string, clause: string, quote: string, source: string) => {
    const specifiers = clause
      .split(',')
      .map(specifier => specifier.trim())
      .filter(specifier => specifier.length > 0);
    const kept: string[] = [];
    const rewritten: string[] = [];
    for (const specifier of specifiers) {
      const name = importedNameOf(specifier);
      const iconModule = specifier.startsWith('type ') ? undefined : iconModuleOf(name, icons);
      if (iconModule !== undefined) {
        rewritten.push(`import { ${specifier} } from ${quote}${PHOSPHOR}/dist/csr/${iconModule}${quote};`);
      } else if (name === 'IconContext') {
        rewritten.push(`import { ${specifier} } from ${quote}${PHOSPHOR}/dist/lib/context${quote};`);
      } else {
        kept.push(specifier);
      }
    }
    if (rewritten.length === 0) return statement;
    if (kept.length > 0) rewritten.push(`import { ${kept.join(', ')} } from ${quote}${source}${quote};`);
    // One line, then as many newlines as the statement had: every later line keeps its number.
    return rewritten.join(' ') + '\n'.repeat(statement.split('\n').length - 1);
  });
}

/**
 * The Vite plugin. Runs before every other transform, on the app's own
 * modules and the workspace packages Vite bundles; never on `node_modules`,
 * whose icon imports are already per icon or are the index itself.
 */
export function phosphorPerIcon(): Plugin {
  let icons: ReadonlySet<string> | undefined;
  return {
    name: 'arki:icons:phosphor-per-icon',
    enforce: 'pre',
    transform: {
      filter: {
        id: { exclude: /[/\\]node_modules[/\\]/ },
        code: /@arki\/icons\/phosphor|@phosphor-icons\/react/,
      },
      handler(code) {
        icons ??= phosphorIconNames();
        const rewritten = rewriteIconImports(code, icons);
        return rewritten === code ? undefined : { code: rewritten, map: null };
      },
    },
  };
}
