/**
 * App-file discovery + dynamic import for the DOT CLI.
 *
 * The CLI inspects a user's DOT app at the command line. Apps live in source
 * files like `dot.config.ts` or `src/app.ts`; this module resolves the right
 * file, imports it, finds the app export, and returns either a
 * `DotApp` or `DotAppBuilder`.
 *
 * The app export is found in this order: the `default` export, else a named
 * export `app` (the shape app templates use), else the one export that looks
 * like a DOT app. Several candidates and no `default`/`app` is an error.
 *
 * The CLI commands (`explain`, `doctor`) then decide whether to call
 * `.configure()` / `.boot()` on the result.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { DotApp, DotAppBuilder, DotAppConfigured } from '../define-app.js';
import type { PluginPhases } from '../plugin-contract.js';
import { AppImportFailed, AppInvalidExport, AppNotFound } from './failures.js';

const debugDiscover = getLogger('arki:dot:cli:discover');

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

export type DiscoveredApp =
  | DotApp<Record<string, unknown>, Failure, Failure, PluginPhases>
  | DotAppBuilder<Record<string, unknown>, Failure, Failure, PluginPhases>
  | DotAppConfigured<Record<string, unknown>, Failure, Failure, PluginPhases>;

export type DiscoveryOptions = {
  /** Explicit app file path. When set, takes precedence over the search list. */
  appPath?: string;
  /** Working directory for discovery. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * `'dev'` (used by `dot dev`): a `dev` export that is an unstarted builder
   * wins over the usual order. Default `'default'`: the usual order only.
   */
  prefer?: 'default' | 'dev';
};

export type DiscoveryResult = {
  /** Absolute path of the resolved app file. */
  filePath: string;
  /** Discovered app (builder, configured, or booted). */
  app: DiscoveredApp;
  /** The export the app was taken from: `default`, `app`, `dev` or another name. */
  exportName: string;
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
    const absolute = path.isAbsolute(options.appPath) ? options.appPath : path.resolve(cwd, options.appPath);
    debugDiscover.debug('explicit app path: {path}', { path: absolute });
    return absolute;
  }

  for (const base of DEFAULT_APP_PATHS) {
    for (const ext of SUPPORTED_EXTENSIONS) {
      const candidate = path.resolve(cwd, `${base}${ext}`);
      if (await fileExists(candidate)) {
        debugDiscover.debug('discovered app file: {file}', { file: candidate });
        return candidate;
      }
    }
  }

  debugDiscover.debug('no app file found at {cwd}', { cwd });
  return null;
}

/**
 * Heuristic guard: detect whether the default export looks like a `DotApp` or
 * `DotAppBuilder` / `DotAppConfigured`. We avoid `instanceof` because the
 * surface types are structural; instead we duck-type the key methods.
 */
function isDotAppBuilder(
  value: unknown,
): value is DotAppBuilder<Record<string, unknown>, Failure, Failure, PluginPhases> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.use === 'function' && typeof v.configure === 'function' && typeof v.boot === 'function';
}

function isDotAppConfigured(
  value: unknown,
): value is DotAppConfigured<Record<string, unknown>, Failure, Failure, PluginPhases> {
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

function isDotApp(value: unknown): value is DotApp<Record<string, unknown>, Failure, Failure, PluginPhases> {
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

type AppExport = { readonly found: true; readonly name: string; readonly value: unknown } | { readonly found: false };

function looksLikeDotApp(value: unknown): boolean {
  return isDotApp(value) || isDotAppBuilder(value) || isDotAppConfigured(value);
}

/**
 * Pick the app export: `default`, else named `app`, else the single export
 * that looks like a DOT app. With `prefer: 'dev'`, a `dev` export that is an
 * unstarted builder comes first. `names` lists every export for error messages.
 */
function findAppExport(
  mod: unknown,
  prefer: 'default' | 'dev',
): AppExport & { readonly names: readonly string[]; readonly matches: readonly string[] } {
  if (typeof mod !== 'object' || mod === null)
    return { found: true, name: 'default', value: mod, names: [], matches: [] };
  const record = mod as Record<string, unknown>;
  const names = Object.keys(record);
  if (prefer === 'dev' && 'dev' in record) {
    if (isDotAppBuilder(record.dev)) return { found: true, name: 'dev', value: record.dev, names, matches: [] };
    debugDiscover.debug('the dev export is not an unstarted builder; using the usual export order');
  }
  if ('default' in record) return { found: true, name: 'default', value: record.default, names, matches: [] };
  if ('app' in record) return { found: true, name: 'app', value: record.app, names, matches: [] };
  const matches = names.filter(name => looksLikeDotApp(record[name]));
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) {
    return { found: true, name: only, value: record[only], names, matches };
  }
  return { found: false, names, matches };
}

/**
 * The code and fix-it hint of an error thrown by a declaration helper
 * (`FeatureError`, `JournalError`, `ScheduleError`, ...), if it carries them.
 * A declaration that rejects a mistake in the code throws while the app
 * module is imported, so its own code is the useful one to show.
 */
function codedCause(err: unknown): { readonly code: string; readonly remediation: string | null } | undefined {
  if (isFailure(err)) return { code: err.code, remediation: err.remediation ?? null };
  if (!(err instanceof Error) || !('code' in err) || typeof err.code !== 'string') return undefined;
  const remediation = 'remediation' in err && typeof err.remediation === 'string' ? err.remediation : null;
  return { code: err.code, remediation };
}

function describeCause(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const coded = codedCause(err);
  return coded === undefined || text.includes(coded.code) ? text : `[${coded.code}] ${text}`;
}

function importFailed(filePath: string, exportName: string | null, error: unknown): Failure {
  const coded = codedCause(error);
  return AppImportFailed(
    {
      filePath,
      exportName,
      causeMessage: describeCause(error),
      causeCode: coded?.code ?? null,
      causeRemediation: coded?.remediation ?? null,
    },
    { cause: error },
  );
}

/**
 * Dynamic-import the app file and unwrap its app export into a `DotApp` /
 * `DotAppBuilder`. A function export is called and awaited. Every failure
 * path is returned: `dot.app_import_failed` or `dot.app_invalid_export`.
 */
export async function loadAppFromFile(filePath: string): Promise<DiscoveredApp | Failure> {
  const loaded = await loadAppExport(filePath, 'default');
  return isFailure(loaded) ? loaded : loaded.app;
}

/** `loadAppFromFile`, also naming the export the app came from. */
async function loadAppExport(
  filePath: string,
  prefer: 'default' | 'dev',
): Promise<{ readonly app: DiscoveredApp; readonly exportName: string } | Failure> {
  let mod: unknown;
  try {
    // Use `pathToFileURL` so dynamic import accepts absolute paths on Windows.
    mod = await import(pathToFileURL(filePath).href);
  } catch (error) {
    return importFailed(filePath, null, error);
  }

  const exported = findAppExport(mod, prefer);
  if (!exported.found) {
    return AppInvalidExport({
      filePath,
      exportName: null,
      exports: [...exported.names],
      matches: [...exported.matches],
    });
  }
  let candidate = exported.value;

  // If the app export is a function, call it (it may return the
  // builder/app, or a Promise of one). This supports lazy/async setup.
  if (typeof candidate === 'function') {
    try {
      const factory: () => unknown = candidate as () => unknown;
      const result = factory();
      candidate = result instanceof Promise ? await result : result;
    } catch (error) {
      return importFailed(filePath, exported.name, error);
    }
  }

  if (isFailure(candidate)) return candidate;
  if (isDotApp(candidate) || isDotAppBuilder(candidate) || isDotAppConfigured(candidate)) {
    debugDiscover.debug('loaded app from {filePath}', { filePath });
    return { app: candidate, exportName: exported.name };
  }

  return AppInvalidExport({ filePath, exportName: exported.name, exports: [...exported.names], matches: [] });
}

/**
 * Resolve the file and load the app. Returns `dot.app_not_found` when no
 * file was found, or the failure of `loadAppFromFile`.
 */
export async function discoverApp(options: DiscoveryOptions = {}): Promise<DiscoveryResult | Failure> {
  const filePath = await resolveAppFile(options);

  if (!filePath) {
    return AppNotFound({ cwd: options.cwd ?? process.cwd(), searched: [...DEFAULT_APP_PATHS] });
  }

  const loaded = await loadAppExport(filePath, options.prefer ?? 'default');
  if (isFailure(loaded)) return loaded;
  return { filePath, app: loaded.app, exportName: loaded.exportName };
}

/**
 * Type guards re-exported for test and renderer consumers.
 */
export const guards = {
  isDotApp,
  isDotAppBuilder,
  isDotAppConfigured,
};
