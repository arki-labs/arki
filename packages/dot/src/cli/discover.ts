/**
 * App-file discovery + dynamic import for the DOT CLI.
 *
 * The CLI inspects a user's DOT app at the command line. Apps live in source
 * files like `dot.config.ts` or `src/app.ts`; this module resolves the right
 * file, imports it, unwraps the default export, and returns either a
 * `DotApp` or `DotAppBuilder`.
 *
 * The CLI commands (`explain`, `doctor`) then decide whether to call
 * `.configure()` / `.boot()` on the result.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDebugLogger } from '@arki/log/debug';

import type { DotApp, DotAppBuilder, DotAppConfigured } from '../define-app.js';
import { DotCliError, DotCliErrorCode } from './error-codes.js';

const debugDiscover = createDebugLogger('arki:dot:cli:discover');

/**
 * Default file names probed at cwd, in priority order.
 * Each entry is tried with each of the supported file extensions below.
 */
const DEFAULT_APP_PATHS: readonly string[] = ['dot.config', 'src/app', 'app'];

/**
 * Supported file extensions. `.ts` is preferred because the CLI runs under
 * Bun, which executes TypeScript natively. `.js` and `.mjs` are accepted for
 * apps that prefer JS sources or pre-compiled output.
 */
const SUPPORTED_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.mjs', '.js'];

export type DiscoveredApp = DotApp<Record<string, unknown>> | DotAppBuilder<Record<string, unknown>> | DotAppConfigured<Record<string, unknown>>;

export type DiscoveryOptions = {
  /** Explicit app file path. When set, takes precedence over the search list. */
  appPath?: string;
  /** Working directory for discovery. Defaults to `process.cwd()`. */
  cwd?: string;
};

export type DiscoveryResult = {
  /** Absolute path of the resolved app file. */
  filePath: string;
  /** Discovered app (builder, configured, or booted). */
  app: DiscoveredApp;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const result = await stat(filePath);
    return result.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve which app file to load.
 *
 * If `appPath` is set, return its absolute path (without checking existence —
 * the caller's `import` will throw with a clearer error if missing).
 * Otherwise, walk the default file list and return the first that exists.
 *
 * Returns `null` when nothing was found.
 */
export async function resolveAppFile(options: DiscoveryOptions = {}): Promise<string | null> {
  const cwd = options.cwd ?? process.cwd();

  if (options.appPath) {
    const absolute = isAbsolute(options.appPath) ? options.appPath : resolve(cwd, options.appPath);
    debugDiscover('explicit app path: %s', absolute);
    return absolute;
  }

  for (const base of DEFAULT_APP_PATHS) {
    for (const ext of SUPPORTED_EXTENSIONS) {
      const candidate = resolve(cwd, `${base}${ext}`);
      if (await fileExists(candidate)) {
        debugDiscover('discovered app file: %s', candidate);
        return candidate;
      }
    }
  }

  debugDiscover('no app file found at %s', cwd);
  return null;
}

/**
 * Heuristic guard: detect whether the default export looks like a `DotApp` or
 * `DotAppBuilder` / `DotAppConfigured`. We avoid `instanceof` because the
 * surface types are structural; instead we duck-type the key methods.
 */
function isDotAppBuilder(value: unknown): value is DotAppBuilder<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.use === 'function' && typeof v.configure === 'function' && typeof v.boot === 'function';
}

function isDotAppConfigured(value: unknown): value is DotAppConfigured<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.boot === 'function' &&
    'manifest' in v &&
    'diagnostics' in v &&
    typeof v.use !== 'function'
  );
}

function isDotApp(value: unknown): value is DotApp<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.dispose === 'function' &&
    typeof v.start === 'function' &&
    typeof v.stop === 'function' &&
    'manifest' in v &&
    'diagnostics' in v &&
    'services' in v
  );
}

function unwrapDefaultExport(mod: unknown): unknown {
  if (typeof mod !== 'object' || mod === null) return mod;
  const record = mod as Record<string, unknown>;
  if ('default' in record) return record.default;
  return mod;
}

/**
 * Dynamic-import the app file and unwrap its default export into a
 * `DotApp` / `DotAppBuilder`. Functions returning either are awaited.
 *
 * Throws `DotCliError` on any failure path.
 */
export async function loadAppFromFile(filePath: string): Promise<DiscoveredApp> {
  let mod: unknown;
  try {
    // Use `pathToFileURL` so dynamic import accepts absolute paths on Windows.
    mod = await import(pathToFileURL(filePath).href);
  } catch (err) {
    throw new DotCliError({
      code: DotCliErrorCode.AppImportFailed,
      message: `Failed to import app file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        'Verify the file path is correct and that the module loads without errors. Run the file directly with `bun <path>` to reproduce.',
      metadata: { filePath },
      cause: err,
    });
  }

  let candidate = unwrapDefaultExport(mod);

  // If the default export is a function, call it (it may return the
  // builder/app, or a Promise of one). This supports lazy/async setup.
  if (typeof candidate === 'function') {
    try {
      const fn = candidate as () => unknown;
      const result = fn();
      candidate = result instanceof Promise ? await result : result;
    } catch (err) {
      throw new DotCliError({
        code: DotCliErrorCode.AppImportFailed,
        message: `Default export function in ${filePath} threw: ${err instanceof Error ? err.message : String(err)}`,
        remediation: 'Make the default-exported factory return a DotApp or DotAppBuilder. Check for setup errors.',
        metadata: { filePath },
        cause: err,
      });
    }
  }

  if (isDotApp(candidate) || isDotAppBuilder(candidate) || isDotAppConfigured(candidate)) {
    debugDiscover('loaded app from %s', filePath);
    return candidate;
  }

  throw new DotCliError({
    code: DotCliErrorCode.AppInvalidExport,
    message: `Default export from ${filePath} is not a DotApp or DotAppBuilder.`,
    remediation:
      'Export a DotApp or DotAppBuilder as the default. Example: `export default defineApp("my-app").use(pip);`',
    metadata: { filePath },
  });
}

/**
 * Combined: resolve the file and load the app. Throws `DotCliError` when no
 * file was found or the import/export shape is invalid.
 */
export async function discoverApp(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const filePath = await resolveAppFile(options);

  if (!filePath) {
    const cwd = options.cwd ?? process.cwd();
    throw new DotCliError({
      code: DotCliErrorCode.AppNotFound,
      message: `No DOT app file found in ${cwd}.`,
      remediation:
        'Create `dot.config.ts` exporting your app (e.g. `export default defineApp("my-app").use(pip)`), or pass `--app <path>` to point at an existing file.',
      metadata: { cwd, searched: DEFAULT_APP_PATHS },
    });
  }

  const app = await loadAppFromFile(filePath);
  return { filePath, app };
}

/**
 * Type guards re-exported for test and renderer consumers.
 */
export const guards = {
  isDotApp,
  isDotAppBuilder,
  isDotAppConfigured,
};
