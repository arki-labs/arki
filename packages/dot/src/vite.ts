/**
 * `@arki/dot/vite` — the Dot app, checked and described while Vite builds.
 *
 * `vite build` imports the app module through Vite's module runner (so
 * aliases, `tsconfig` paths and workspace packages resolve the way the app's
 * own bundle resolves them), runs `configure()` and never `boot()`: nothing
 * opens. An app that does not configure fails the build, so the mistake
 * surfaces here instead of on the first production request. The manifest and
 * every registered projection document (`dot explain --as <format>`, for
 * example `openapi`) are written into the server output as JSON files, so
 * readers load a file instead of configuring the app again. `vite dev` runs
 * the same check on start and after every change to the app's module graph,
 * and reports in the terminal.
 *
 * ```ts
 * // vite.config.ts of a TanStack Start app that hosts a Dot app
 * import { dotVite } from '@arki/dot/vite';
 *
 * export default defineConfig({
 *   plugins: [dotVite({ app: '../backend/src/app.ts' })],
 * });
 * ```
 *
 * `vite` is an optional peer of `@arki/dot`. Import this module from a Vite
 * config only; the rest of Dot never loads it.
 */
import path from 'node:path';
import type { InlineConfig, Logger, Plugin, ViteDevServer } from 'vite';
import { runnerImport } from 'vite';

import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { DotAppManifest } from './manifest.js';
import { appFromModule, importFailed } from './cli/discover.js';
import { manifestOf } from './cli/explain.js';
import { renderProjection } from './cli/render-projection.js';

export type DotViteOptions = {
  /**
   * The app module, relative to the Vite root or absolute. It exports the app
   * the way the `dot` CLI finds it: `default`, else `app`, else the one export
   * that is a Dot app.
   */
  readonly app: string;
  /** File name of the manifest JSON in the server output. `false` writes none. Default `dot-manifest.json`. */
  readonly manifestFile?: string | false;
  /** Write each registered projection as `<format>.json` in the server output. Default `true`. */
  readonly projections?: boolean;
  /** Vite config for the import of the app module (aliases, conditions). Default: the app's root with `tsconfig` paths. */
  readonly importConfig?: InlineConfig;
};

/** What the build knows about the app once it configured: the manifest, the files to write, the modules it read. */
export type DotBuildDescription = {
  readonly manifest: DotAppManifest;
  /** `fileName → JSON text`: the manifest and one document per projection format. */
  readonly files: ReadonlyMap<string, string>;
  /** Every module the app import read; the dev server re-checks when one changes. */
  readonly dependencies: readonly string[];
};

export type DescribeDotAppOptions = {
  /** The Vite root the app path and its imports resolve against. */
  readonly root: string;
  readonly manifestFile: string | false;
  readonly projections: boolean;
  readonly importConfig: InlineConfig | undefined;
};

const PLUGIN_NAME = 'arki-dot';

/** `[code] message remediation`, the way `dot` prints a failure. */
function describeFailure(failure: Failure): string {
  const remediation = failure.remediation === undefined ? '' : ` ${failure.remediation}`;
  return `[${failure.code}] ${failure.message}${remediation}`;
}

/** Projection formats in registration order, each once. */
function formatsOf(manifest: DotAppManifest): readonly string[] {
  return [...new Set(manifest.projections.map(projection => projection.format))];
}

/** `custom:doc` → `custom-doc.json`: a format key is free text, a file name is not. */
function fileNameOf(format: string): string {
  return `${format.replaceAll(/[^\w.-]/g, '-')}.json`;
}

/**
 * Import the app through Vite, configure it, and render its manifest and
 * projections to JSON. Every failure is returned, never thrown: an import
 * error, a module that exports no app, a `configure()` that refuses the
 * composition, or a projection module that cannot render.
 */
export async function describeDotApp(
  appFilePath: string,
  options: DescribeDotAppOptions,
): Promise<DotBuildDescription | Failure> {
  const importConfig: InlineConfig = {
    root: options.root,
    configFile: false,
    logLevel: 'error',
    resolve: { tsconfigPaths: true },
    ...options.importConfig,
  };
  let imported: { readonly module: unknown; readonly dependencies: readonly string[] };
  try {
    imported = await runnerImport<unknown>(appFilePath, importConfig);
  } catch (error) {
    return importFailed(appFilePath, null, error);
  }

  const loaded = await appFromModule(imported.module, appFilePath);
  if (isFailure(loaded)) return loaded;
  const manifest = manifestOf(loaded.app);
  if (isFailure(manifest)) return manifest;

  // Projection modules load through the same runner, so a workspace package
  // distributed as TypeScript source loads under Node the way the app did.
  // A relative specifier is relative to the app file, as the CLI reads it.
  const appDir = path.dirname(appFilePath);
  const importModule = async (specifier: string): Promise<unknown> => {
    const id = specifier.startsWith('.') ? path.resolve(appDir, specifier) : specifier;
    const { module } = await runnerImport<unknown>(id, importConfig);
    return module;
  };

  const files = new Map<string, string>();
  if (options.manifestFile !== false) files.set(options.manifestFile, JSON.stringify(manifest, null, 2));
  if (options.projections) {
    for (const format of formatsOf(manifest)) {
      const projected = await renderProjection({ manifest, format, appFilePath, importModule });
      if (isFailure(projected)) return projected;
      files.set(fileNameOf(format), JSON.stringify(projected.document, null, 2));
    }
  }
  return { manifest, files, dependencies: imported.dependencies };
}

/**
 * The Vite plugin. `vite build`: the app is described once per process (Vite
 * runs `buildStart` once per environment) and a failure fails the build; the
 * files are emitted into the server environment's output only, never the
 * client's. `vite dev`: the same check on start and whenever a module of the
 * app's graph changes, reported through Vite's logger.
 */
export function dotVite(options: DotViteOptions): Plugin {
  const manifestFile = options.manifestFile ?? 'dot-manifest.json';
  const projections = options.projections ?? true;
  let root = '';
  let appFilePath = '';
  let logger: Logger | undefined;
  let failOnError = true;
  let devServer: ViteDevServer | undefined;
  let described: Promise<DotBuildDescription | undefined> | undefined;
  const watched = new Set<string>();

  const describe = async (): Promise<DotBuildDescription | undefined> => {
    const result = await describeDotApp(appFilePath, {
      root,
      manifestFile,
      projections,
      importConfig: options.importConfig,
    });
    if (isFailure(result)) {
      const text = `[${PLUGIN_NAME}] ${describeFailure(result)}`;
      if (failOnError) throw new Error(text, { cause: result });
      logger?.error(text, { timestamp: true });
      return undefined;
    }
    const { app, plugins } = result.manifest;
    logger?.info(`[${PLUGIN_NAME}] ${app.name} configures: ${plugins.length} plugins, ${result.files.size} files`, {
      timestamp: true,
    });
    return result;
  };

  /** Watch every module the app import read, so an edit anywhere in its graph re-checks the app. */
  const watch = (result: DotBuildDescription | undefined): void => {
    if (result === undefined || devServer === undefined) return;
    for (const file of result.dependencies) {
      if (watched.has(file)) continue;
      watched.add(file);
      devServer.watcher.add(file);
    }
  };

  return {
    name: PLUGIN_NAME,
    configResolved(config) {
      root = config.root;
      appFilePath = path.resolve(config.root, options.app);
      logger = config.logger;
      failOnError = config.command === 'build';
    },
    async buildStart() {
      described ??= describe();
      watch(await described);
    },
    async generateBundle() {
      if (this.environment.config.consumer !== 'server') return;
      const result = await described;
      if (result === undefined) return;
      for (const [fileName, source] of result.files) this.emitFile({ type: 'asset', fileName, source });
    },
    configureServer(server) {
      devServer = server;
      server.watcher.on('change', file => {
        if (!watched.has(file)) return;
        described = describe();
        void described.then(watch);
      });
    },
  };
}
