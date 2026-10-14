/**
 * Loading TypeScript suites under Node. Node's type stripping loads `.ts`
 * files but, unlike TypeScript's NodeNext resolution, does not map
 * `import './x.js'` to `./x.ts`. Suites written in TypeScript (and this
 * package when it runs from source) import that way, so a relative `.js`
 * import from a `.ts` file that does not exist falls back to the `.ts` file
 * next to it.
 *
 * Shared by every place that imports suites: the measuring worker and the
 * CLI's `check` and `list` (through `loadSuite`). Imports only `node:` modules,
 * so it loads before the resolver exists.
 */
import { register } from 'node:module';

const RESOLVE_JS_TO_TS = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const fromTypeScript = /\\.[cm]?tsx?$/.test(context.parentURL ?? '');
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !fromTypeScript || !/^\\.{1,2}\\//.test(specifier)) throw error;
    const mapped = specifier.replace(/\\.([cm]?)js$/, '.$1ts');
    if (mapped === specifier) throw error;
    return nextResolve(mapped, context);
  }
}
`;

let registered = false;

/** True under Node with type stripping on (a flag, or Node ≥ 22.18 / 23.6 by default); Bun and Deno resolve `.js` → `.ts` themselves. */
function isNodeStrippingTypes(): boolean {
  return (
    typeof process.versions.bun !== 'string' &&
    typeof process.versions.deno !== 'string' &&
    Boolean(process.features.typescript)
  );
}

/** @internal Registers the `.js` → `.ts` fallback once per process, where Node needs it. */
export function registerTypeScriptResolver(): void {
  if (registered || !isNodeStrippingTypes()) return;
  register(`data:text/javascript,${encodeURIComponent(RESOLVE_JS_TO_TS)}`);
  registered = true;
}
