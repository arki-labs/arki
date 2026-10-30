/**
 * `dot explain --as <format>`: select the projection the app registered,
 * resolve its module relative to the app file, import it and run
 * `project(manifest)`. The adapter owns the projection module and its
 * document vocabulary; every failure here is returned, not thrown.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';
import { is, plainObjectSchema, recordSchema } from '@arki/schema';

import type { DotAppManifest, JsonValue, ProjectionManifest } from '../manifest.js';
import {
  ProjectionConflict,
  ProjectionExecutionFailed,
  ProjectionImportFailed,
  ProjectionNotFound,
} from './failures.js';

/**
 * The `data` of `explain --as`: the format and the document `project(manifest)` returned. `text` is set when
 * the module also exports `render(document)`: what `dot explain --as <format>` prints without `--json`.
 */
export type ProjectionData = {
  format: string;
  document: JsonValue;
  text?: string;
  /** Set when `page` was asked for and the module exports `consolePage(document)`: the console page's HTML. */
  page?: string;
};

type ProjectionModule = {
  project(manifest: DotAppManifest): unknown;
  render?: (document: JsonValue) => unknown;
  consolePage?: (document: JsonValue) => unknown;
};

export type ProjectionSource = {
  manifest: DotAppManifest;
  format: string;
  /** Absolute app file path; projection specifiers resolve relative to it. */
  appFilePath: string;
  /** Per-invocation debug override for the selected projection module. */
  module?: string;
  /** Also run the module's `consolePage(document)` and return its HTML as `page`. */
  page?: boolean;
  /**
   * How to import the projection module. Default: resolve the specifier
   * relative to the app file (Bun's resolver, else Node's) and `import()` it.
   * `@arki/dot/vite` imports through Vite's module runner instead, so a
   * workspace package distributed as TypeScript source loads under Node too.
   */
  importModule?: (specifier: string) => Promise<unknown>;
};

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item));
  if (!is(value, plainObjectSchema)) return false;
  return Object.values(value).every(item => isJsonValue(item));
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) || isJsonPrimitive(right)) return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (!is(left, plainObjectSchema) || !is(right, plainObjectSchema)) return false;
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

function selectProjection(manifest: DotAppManifest, format: string): ProjectionManifest | Failure {
  const projections = manifest.projections.filter(projection => projection.format === format);
  const [first] = projections;
  if (first === undefined) {
    const registeredFormats = [...new Set(manifest.projections.map(projection => projection.format))];
    return ProjectionNotFound({ format, registeredFormats });
  }
  const modules = new Set(projections.map(projection => projection.module));
  if (modules.size > 1) {
    return ProjectionConflict({
      format,
      projections: projections.map(projection => ({ plugin: projection.plugin, module: projection.module })),
    });
  }
  return first;
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
  if (path.isAbsolute(resolved)) return pathToFileURL(resolved).href;
  return resolved;
}

function resolveProjectionSpecifier(specifier: string, appFilePath: string): string {
  const fromDir = path.dirname(appFilePath);
  const bun = getBunResolver();
  if (bun !== undefined) return bun.resolveSync(specifier, fromDir);
  return createRequire(appFilePath).resolve(specifier);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasProject(value: unknown): value is ProjectionModule {
  return (
    is(value, recordSchema) &&
    typeof value['project'] === 'function' &&
    (value['render'] === undefined || typeof value['render'] === 'function') &&
    (value['consolePage'] === undefined || typeof value['consolePage'] === 'function')
  );
}

/** Resolve the specifier relative to the app file and `import()` it: the default importer. */
function importRelativeToApp(appFilePath: string): (specifier: string) => Promise<unknown> {
  return async specifier => {
    let resolved: string;
    try {
      resolved = resolveProjectionSpecifier(specifier, appFilePath);
    } catch (error) {
      throw new ProjectionResolveError(error);
    }
    return import(importSpecifierFor(resolved));
  };
}

/** Marks a failure of the resolve step, so the import failure names that stage. */
class ProjectionResolveError extends Error {
  constructor(override readonly cause: unknown) {
    super(messageOf(cause), { cause });
  }
}

async function loadProjectionModule(
  specifier: string,
  registeringPlugin: string,
  importModule: (specifier: string) => Promise<unknown>,
): Promise<ProjectionModule | Failure> {
  let imported: unknown;
  try {
    imported = await importModule(specifier);
  } catch (error) {
    if (error instanceof ProjectionResolveError) {
      return ProjectionImportFailed(
        { specifier, registeringPlugin, stage: 'resolve', causeMessage: error.message },
        { cause: error.cause },
      );
    }
    return ProjectionImportFailed(
      { specifier, registeringPlugin, stage: 'import', causeMessage: messageOf(error) },
      { cause: error },
    );
  }

  if (!hasProject(imported)) {
    return ProjectionImportFailed({ specifier, registeringPlugin, stage: 'export', causeMessage: null });
  }
  return imported;
}

/** Run the projection registered for `source.format` and return its document. */
export async function renderProjection(source: ProjectionSource): Promise<ProjectionData | Failure> {
  const projection = selectProjection(source.manifest, source.format);
  if (isFailure(projection)) return projection;
  const specifier = source.module ?? projection.module;
  const importModule = source.importModule ?? importRelativeToApp(source.appFilePath);
  const loaded = await loadProjectionModule(specifier, projection.plugin, importModule);
  if (isFailure(loaded)) return loaded;

  try {
    const document = toProjectionJsonValue(await loaded.project(source.manifest));
    let page: string | undefined;
    if (source.page === true) {
      if (loaded.consolePage === undefined)
        throw new TypeError('A projection module needs consolePage(document) to give the console a page.');
      const html = loaded.consolePage(document);
      if (typeof html !== 'string')
        throw new TypeError('A projection module\'s consolePage(document) must return a string.');
      page = html;
    }
    const withPage = page === undefined ? {} : { page };
    if (loaded.render === undefined) return { format: source.format, document, ...withPage };
    const text = loaded.render(document);
    if (typeof text !== 'string') throw new TypeError('A projection module\'s render(document) must return a string.');
    return { format: source.format, document, text, ...withPage };
  } catch (error) {
    return ProjectionExecutionFailed(
      { format: source.format, specifier, registeringPlugin: projection.plugin, causeMessage: messageOf(error) },
      { cause: error },
    );
  }
}

/** True when a command's data is the `--as` payload. */
export function isProjectionData(value: unknown): value is ProjectionData {
  return is(value, recordSchema) && 'format' in value && 'document' in value;
}
