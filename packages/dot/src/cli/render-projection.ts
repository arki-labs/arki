/**
 * Renderer for `dot explain --as <format>`.
 *
 * The kernel owns selection, app-file-relative module resolution, import, and
 * envelope printing. The adapter owns the projection module and document
 * vocabulary.
 */

import { createRequire } from 'node:module';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DotAppManifest, JsonValue, ProjectionManifest } from '../manifest.js';
import type { DotCliEnvelope, RenderOptions } from './render-explain.js';
import { DotCliError, DotCliErrorCode } from './error-codes.js';

export type ProjectionData = {
  format: string;
  document: JsonValue;
};

type ProjectionModule = {
  project(manifest: DotAppManifest): unknown | Promise<unknown>;
};

export type ProjectionSource = {
  manifest: DotAppManifest;
  command: 'explain';
  format: string;
  /** Absolute app file path; projection specifiers resolve relative to it. */
  appFilePath: string;
  /** Per-invocation debug override for the selected projection module. */
  module?: string;
};

const defaultOut = (line: string) => {
  process.stdout.write(line);
};

function nowIso(opts: RenderOptions): string {
  const factory = opts.now ?? (() => new Date());
  return factory().toISOString();
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) || isJsonPrimitive(right)) return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.hasOwn(right, key) || !jsonDeepEqual(value, right[key])) return false;
  }
  return true;
}

function toProjectionJsonValue(value: unknown): JsonValue {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError('Projection output must be JSON-serializable.', { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError('Projection output must be JSON-serializable.');
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!isJsonValue(parsed) || !jsonDeepEqual(value, parsed)) {
    throw new TypeError('Projection output must survive a JSON round trip without lossy coercions.');
  }
  return parsed;
}

function selectProjection(manifest: DotAppManifest, format: string): ProjectionManifest {
  const projections = manifest.projections.filter(projection => projection.format === format);
  if (projections.length === 0) {
    const formats = [...new Set(manifest.projections.map(projection => projection.format))];
    throw new DotCliError({
      code: DotCliErrorCode.ProjectionNotFound,
      message: `No projection is registered for format "${format}".`,
      remediation:
        formats.length === 0
          ? 'Register an adapter that contributes this projection format, or remove --as.'
          : `Use one of the registered formats (${formats.join(', ')}), or mount the adapter that provides "${format}".`,
      metadata: { format, registeredFormats: formats },
    });
  }

  const modules = new Set(projections.map(projection => projection.module));
  if (modules.size > 1) {
    throw new DotCliError({
      code: DotCliErrorCode.ProjectionConflict,
      message: `Multiple projection modules are registered for format "${format}".`,
      remediation:
        'Only one module may own a projection format. Remove one registration, or make both plugins register the same module specifier.',
      metadata: {
        format,
        projections: projections.map(projection => ({ plugin: projection.plugin, module: projection.module })),
      },
    });
  }

  return projections[0]!;
}

function getBunResolver(): { resolveSync(specifier: string, from: string): string } | undefined {
  const candidate = (globalThis as { Bun?: unknown }).Bun;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const resolveSync = (candidate as { resolveSync?: unknown }).resolveSync;
  if (typeof resolveSync !== 'function') return undefined;
  return { resolveSync: (specifier, from) => resolveSync.call(candidate, specifier, from) as string };
}

function importSpecifierFor(resolved: string): string {
  if (resolved.startsWith('file:')) return resolved;
  if (isAbsolute(resolved)) return pathToFileURL(resolved).href;
  return resolved;
}

function resolveProjectionSpecifier(specifier: string, appFilePath: string): string {
  const fromDir = dirname(appFilePath);
  const bun = getBunResolver();
  if (bun !== undefined) return bun.resolveSync(specifier, fromDir);
  return createRequire(appFilePath).resolve(specifier);
}

async function loadProjectionModule(
  specifier: string,
  appFilePath: string,
  registeringPlugin: string,
): Promise<{ module: ProjectionModule; resolved: string }> {
  let resolved: string;
  try {
    resolved = resolveProjectionSpecifier(specifier, appFilePath);
  } catch (error) {
    throw new DotCliError({
      code: DotCliErrorCode.ProjectionImportFailed,
      message: `Failed to resolve projection module "${specifier}".`,
      remediation:
        'Check that the projection module is installed and that package subpath exports include a default condition. Use --module <specifier> to debug with a replacement module.',
      metadata: { specifier, appFilePath, registeringPlugin },
      cause: error,
    });
  }

  let imported: unknown;
  try {
    imported = await import(importSpecifierFor(resolved));
  } catch (error) {
    throw new DotCliError({
      code: DotCliErrorCode.ProjectionImportFailed,
      message: `Failed to import projection module "${specifier}".`,
      remediation:
        'Fix the projection module export, or use --module <specifier> to debug with a replacement module.',
      metadata: { specifier, resolved, registeringPlugin },
      cause: error,
    });
  }

  if (typeof imported !== 'object' || imported === null || typeof (imported as { project?: unknown }).project !== 'function') {
    throw new DotCliError({
      code: DotCliErrorCode.ProjectionImportFailed,
      message: `Projection module "${specifier}" does not export project(manifest).`,
      remediation:
        'Export a named `project(manifest)` function from the projection module. Use --module <specifier> to test a corrected module.',
      metadata: { specifier, resolved, registeringPlugin },
    });
  }

  return { module: imported as ProjectionModule, resolved };
}

/**
 * Render an adapter-owned projection. Plain mode prints strings verbatim and
 * JSON values as pretty JSON; JSON mode wraps the document in the standard
 * CLI envelope.
 */
export async function renderProjection(
  source: ProjectionSource,
  opts: RenderOptions,
): Promise<DotCliEnvelope<ProjectionData>> {
  const projection = selectProjection(source.manifest, source.format);
  const specifier = source.module ?? projection.module;
  const { module } = await loadProjectionModule(specifier, source.appFilePath, projection.plugin);

  let document: JsonValue;
  try {
    document = toProjectionJsonValue(await module.project(source.manifest));
  } catch (error) {
    throw new DotCliError({
      code: DotCliErrorCode.ProjectionExecutionFailed,
      message: `Projection "${source.format}" failed while rendering.`,
      remediation:
        'Fix the projection project(manifest) function so it is pure and returns JSON-round-trip-safe output.',
      metadata: { format: source.format, specifier, registeringPlugin: projection.plugin },
      cause: error,
    });
  }

  const envelope: DotCliEnvelope<ProjectionData> = {
    status: 'success',
    command: source.command,
    generatedAt: nowIso(opts),
    data: { format: source.format, document },
    errors: [],
  };

  const out = opts.out ?? defaultOut;
  if (opts.json) {
    out(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (typeof document === 'string') {
    out(`${document}\n`);
  } else {
    out(`${JSON.stringify(document, null, 2)}\n`);
  }

  return envelope;
}
