/**
 * Bundle size: what a consumer ships when they import a case's `source`.
 *
 * Each case is bundled on its own with Bun's bundler (minified, browser
 * target, production `NODE_ENV`, no code splitting). Every output counts —
 * JavaScript, CSS and assets — and each file is compressed separately with
 * gzip (level 9) and Brotli (quality 11), the way a CDN serves them.
 *
 * Under Bun the bundler is called in-process. Under Node and Deno a short
 * `bun` child process does the bundling; without `bun` on PATH the group is
 * returned unmeasured with a warning instead of failing the run.
 */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

import type {
  CaseResult,
  CaseRole,
  Comparison,
  Flag,
  GroupResult,
  SizeRunner,
  SizeSpec,
  Summary,
  Warning,
} from '../core/types.js';
import { parseSize } from '../core/spec.js';
import { exactComparison } from '../core/stats.js';

/**
 * Left out of every bundle unless the group sets its own `externals` (which
 * replace this list): the app provides React, and `bun:*` modules only exist
 * under Bun. Bun's bundler refuses `bun:jsc` for the browser target even when
 * the import is guarded at runtime (mitata does that).
 */
export const DEFAULT_EXTERNALS: readonly string[] = ['react', 'react-dom', 'react/jsx-runtime', 'bun:*'];

/** How many input modules `size.contributors` lists. */
const CONTRIBUTORS = 10;

/** @internal One bundle to build: a single entry file into its own output directory. */
export type BundleRequest = { entry: string; outdir: string; externals: readonly string[]; root: string };

/** @internal What the bundler produced: absolute output paths and the largest inputs. */
export type BundleOutput = { files: readonly string[]; contributors: readonly { path: string; bytes: number }[] };

type BunMetafile = { outputs?: Record<string, { inputs?: Record<string, { bytesInOutput?: number }> }> };

type BunBuildResult = {
  success: boolean;
  outputs: readonly { path: string; kind: string }[];
  logs: readonly unknown[];
  metafile?: BunMetafile;
};

/** @internal The slice of the `Bun` global this module uses. */
export type BunApi = {
  build: (config: {
    entrypoints: string[];
    outdir: string;
    minify: boolean;
    target: 'browser';
    splitting: boolean;
    metafile: boolean;
    sourcemap: 'none';
    define: Record<string, string>;
    external: string[];
  }) => Promise<BunBuildResult>;
};

function isBunApi(value: unknown): value is BunApi {
  return typeof value === 'object' && value !== null && 'build' in value && typeof value.build === 'function';
}

/** @internal The `Bun` global when running under Bun. */
export function getBun(): BunApi | undefined {
  const candidate: unknown = Reflect.get(globalThis, 'Bun');
  return isBunApi(candidate) ? candidate : undefined;
}

function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/** @internal Bundle one entry with the Bun API (in-process under Bun, or inside the size worker). */
export async function bundleWithBun(bun: BunApi, request: BundleRequest): Promise<BundleOutput> {
  let result: BunBuildResult;
  try {
    result = await bun.build({
      entrypoints: [request.entry],
      outdir: request.outdir,
      minify: true,
      target: 'browser',
      splitting: false,
      metafile: true,
      sourcemap: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
      external: [...request.externals],
    });
  } catch (error) {
    const details = error instanceof AggregateError ? error.errors.map(item => describe(item)) : [describe(error)];
    throw new Error(`Bundling ${request.entry} failed:\n${details.join('\n')}`, { cause: error });
  }
  if (!result.success) {
    throw new Error(`Bundling ${request.entry} failed:\n${result.logs.map(item => describe(item)).join('\n')}`);
  }

  const bytesByInput = new Map<string, number>();
  // process.cwd() is a real path (macOS: /private/var/…), so compare against the real root.
  const root = realpathSync(request.root);
  for (const output of Object.values(result.metafile?.outputs ?? {})) {
    for (const [input, info] of Object.entries(output.inputs ?? {})) {
      const bytes = info.bytesInOutput ?? 0;
      if (bytes <= 0) continue;
      // Metafile paths are relative to the bundling process's cwd; report them from the package root.
      const modulePath = path.relative(root, path.resolve(process.cwd(), input));
      bytesByInput.set(modulePath, (bytesByInput.get(modulePath) ?? 0) + bytes);
    }
  }
  const contributors = [...bytesByInput]
    .map(([modulePath, bytes]) => ({ path: modulePath, bytes }))
    .toSorted((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, CONTRIBUTORS);

  return {
    files: result.outputs.filter(output => output.kind !== 'sourcemap').map(output => output.path),
    contributors,
  };
}

/** @internal Validates the request the size worker receives. */
export function isBundleRequest(value: unknown): value is BundleRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entry' in value &&
    typeof value.entry === 'string' &&
    'outdir' in value &&
    typeof value.outdir === 'string' &&
    'root' in value &&
    typeof value.root === 'string' &&
    'externals' in value &&
    Array.isArray(value.externals) &&
    value.externals.every(item => typeof item === 'string')
  );
}

/** @internal Validates the size worker's JSON answer. */
export function isBundleOutput(value: unknown): value is BundleOutput {
  if (typeof value !== 'object' || value === null) return false;
  if (!('files' in value) || !Array.isArray(value.files) || !value.files.every(file => typeof file === 'string')) {
    return false;
  }
  return (
    'contributors' in value &&
    Array.isArray(value.contributors) &&
    value.contributors.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'path' in item &&
        typeof item.path === 'string' &&
        'bytes' in item &&
        typeof item.bytes === 'number',
    )
  );
}

/** The size worker next to this module: compiled `.js` in dist, `.ts` when running from source (Bun runs either). */
function sizeWorkerPath(): string {
  const js = fileURLToPath(new URL('size-worker.js', import.meta.url));
  if (existsSync(js)) return js;
  return fileURLToPath(new URL('size-worker.ts', import.meta.url));
}

class BunMissingError extends Error {}

/** Bundle in a `bun` child process (Node and Deno hosts). */
function bundleInBunProcess(request: BundleRequest): Promise<BundleOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bun', [sizeWorkerPath(), JSON.stringify(request)], {
      cwd: request.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', error => {
      reject('code' in error && error.code === 'ENOENT' ? new BunMissingError('bun is not on PATH') : error);
    });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `The bun size worker exited with code ${String(code)}.`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`The bun size worker printed something that is not JSON:\n${stdout.slice(0, 500)}`));
        return;
      }
      if (isBundleOutput(parsed)) resolvePromise(parsed);
      else reject(new Error('The bun size worker returned an unexpected answer.'));
    });
  });
}

/** File-name-safe form of a group or case id. */
function safe(id: string): string {
  return id.replaceAll(/[^\w.-]/g, '_');
}

async function measureFile(file: string, outdir: string): Promise<FileSize> {
  const bytes = await readFile(file);
  return {
    path: path.relative(outdir, file),
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }).length,
  };
}

type FileSize = { path: string; raw: number; gzip: number; brotli: number };

function total(files: readonly FileSize[], field: 'raw' | 'gzip' | 'brotli'): number {
  return files.reduce((sum, file) => sum + file[field], 0);
}

/** A size is measured exactly once: the interval is the value itself. */
function exactSummary(value: number): Summary {
  return {
    estimate: value,
    interval: [value, value],
    median: value,
    min: value,
    max: value,
    p75: value,
    p99: value,
    cv: 0,
    n: 1,
  };
}

function roleOf(group: SizeSpec, key: string, spec: { differs?: string; variant?: boolean }): CaseRole {
  if (key === group.baseline) return 'baseline';
  if (spec.differs !== undefined) return 'differs';
  return spec.variant ? 'variant' : 'competitor';
}

/** Ratio of gzip totals vs the baseline; exact, so the interval is [r, r] and the verdict uses the shared band. Lower is better. */
function sizeComparisons(group: SizeSpec, cases: readonly CaseResult[]): Comparison[] {
  const base = cases.find(item => item.key === group.baseline)?.size?.gzip;
  if (base === undefined || base === 0) return [];
  return cases
    .filter(item => (item.role === 'competitor' || item.role === 'variant') && item.size !== undefined)
    .map(item => ({ case: item.key, ...exactComparison(base, item.size?.gzip ?? 0) }));
}

/**
 * Creates the size runner the engine calls for `size` groups. `cwd` is the
 * package root: entries are written to `<cwd>/.cache/bench-size/` so their
 * imports resolve against that package's dependencies.
 */
export function createSizeRunner(options: { cwd: string }): SizeRunner {
  const root = path.resolve(options.cwd);
  const cacheDir = path.join(root, '.cache', 'bench-size');

  return async (group: SizeSpec): Promise<GroupResult> => {
    const externals = group.externals ?? DEFAULT_EXTERNALS;
    const bun = getBun();
    const cases: CaseResult[] = [];
    await mkdir(cacheDir, { recursive: true });

    for (const [key, spec] of Object.entries(group.cases)) {
      const name = `${safe(group.id)}-${safe(key)}`;
      const entry = path.join(cacheDir, `${name}.${spec.ext ?? 'js'}`);
      const outdir = path.join(cacheDir, name);
      const limit = spec.limit === undefined ? undefined : parseSize(spec.limit);
      if (spec.limit !== undefined && limit === undefined) {
        throw new Error(
          `Size case "${key}" in "${group.id}": invalid limit "${spec.limit}" (use e.g. '8 kB', '1.5 KiB', '900 B').`,
        );
      }
      await writeFile(entry, spec.source);
      await rm(outdir, { recursive: true, force: true });

      const request: BundleRequest = { entry, outdir, externals, root };
      let output: BundleOutput;
      try {
        output = bun ? await bundleWithBun(bun, request) : await bundleInBunProcess(request);
      } catch (error) {
        if (!(error instanceof BunMissingError)) throw error;
        const warning: Warning = {
          code: 'size-unavailable',
          group: group.id,
          message: `Bundle size was not measured: it needs Bun's bundler and \`bun\` is not on PATH. Install Bun (https://bun.sh) and run again.`,
        };
        return {
          kind: 'size',
          id: group.id,
          title: group.title,
          ...(group.note === undefined ? {} : { note: group.note }),
          unit: 'bytes',
          baseline: group.baseline,
          cases: [],
          comparisons: [],
          warnings: [warning],
        };
      }

      const measured = await Promise.all(output.files.map(file => measureFile(file, outdir)));
      const files = measured.toSorted((a, b) => a.path.localeCompare(b.path));
      const gzip = total(files, 'gzip');
      const flags: Flag[] = limit !== undefined && gzip > limit ? ['over-limit'] : [];

      cases.push({
        key,
        label: spec.label ?? key,
        ...(spec.package === undefined ? {} : { package: spec.package }),
        role: roleOf(group, key, spec),
        ...(spec.differs === undefined ? {} : { differs: spec.differs }),
        summary: exactSummary(gzip),
        size: {
          raw: total(files, 'raw'),
          gzip,
          brotli: total(files, 'brotli'),
          files,
          contributors: output.contributors,
        },
        ...(limit === undefined ? {} : { limit }),
        flags,
      });
    }

    return {
      kind: 'size',
      id: group.id,
      title: group.title,
      ...(group.note === undefined ? {} : { note: group.note }),
      unit: 'bytes',
      baseline: group.baseline,
      cases,
      comparisons: sizeComparisons(group, cases),
    };
  };
}
