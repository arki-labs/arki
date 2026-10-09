/**
 * Loader and validator for `arki.release.config.ts`.
 *
 * The config is a typed TypeScript module — not JSON — so it can be
 * imported directly with type-safe references to the wave union and the
 * metadata defaults. This module:
 *
 *   1. Imports the config from the repo root (default path) OR from an
 *      explicit path passed in (used by tests to point at fixtures).
 *   2. Validates the runtime shape (in addition to the compile-time type),
 *      because the file is editable and a malformed config should fail
 *      loudly with a stable error code instead of silently producing
 *      garbage envelopes downstream.
 *
 * Validation here is intentionally narrow: structural checks only. The
 * loader does NOT cross-reference wave entries against the workspace —
 * that's the inventory command's job.
 */

import path from 'node:path';

import debugFactory from 'debug';

import type {
  LeakPattern,
  PublicMetadataDefaults,
  ReleaseConfig,
  ReleaseWave,
  ReleaseWaveId,
} from './types';

const debug = debugFactory('arki:release:config');

/** Stable error codes emitted when loading or validating the config. */
export const CONFIG_ERROR_CODES = {
  /** Config module did not export a recognizable config object. */
  malformedExport: 'CFG_E001',
  /** Config object is missing a required top-level field. */
  missingField: 'CFG_E002',
  /** A field has the wrong type or shape. */
  invalidShape: 'CFG_E003',
  /** A wave references a package name that is not a `@arki/*` string. */
  invalidWavePackage: 'CFG_E004',
  /** Two waves declare the same package — package may only belong to one wave. */
  duplicatePackage: 'CFG_E005',
} as const;

/** Thrown when validation fails. The CLI catches and converts to envelope. */
export class ReleaseConfigError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ReleaseConfigError';
  }
}

/** Resolve the default config path: `<cwd>/arki.release.config.ts`. */
export function defaultConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, 'arki.release.config.ts');
}

/**
 * Load the config from a TypeScript module path. Uses dynamic `import()`
 * which Bun resolves natively for `.ts` files.
 *
 * Returns the validated config or throws {@link ReleaseConfigError}.
 */
export async function loadConfig(configPath: string): Promise<ReleaseConfig> {
  debug('loading config from %s', configPath);
  let mod: unknown;
  try {
    mod = (await import(configPath)) as unknown;
  } catch (cause) {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.malformedExport,
      `Failed to import config at ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return validateConfig(extractExport(mod));
}

/**
 * Extract the config object from a freshly imported module. Accepts
 * either `export default config` or `export const config = ...`.
 */
function extractExport(mod: unknown): unknown {
  if (mod === null || typeof mod !== 'object') {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.malformedExport,
      'Config module did not export an object.',
    );
  }
  const record = mod as Record<string, unknown>;
  if (record['default'] !== undefined) {
    return record['default'];
  }
  if (record['config'] !== undefined) {
    return record['config'];
  }
  throw new ReleaseConfigError(
    CONFIG_ERROR_CODES.malformedExport,
    'Config module must export `default` or `config`.',
  );
}

/**
 * Validate the runtime shape of the config object. Returns the same
 * object narrowed to {@link ReleaseConfig} on success; throws otherwise.
 *
 * Exposed for tests that want to validate an in-memory fixture without
 * touching the filesystem.
 */
export function validateConfig(raw: unknown): ReleaseConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.invalidShape,
      'Config must be an object.',
    );
  }
  const record = raw as Record<string, unknown>;

  const publicTreePath = record['publicTreePath'];
  if (typeof publicTreePath !== 'string' || publicTreePath.length === 0) {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.missingField,
      'Config field `publicTreePath` must be a non-empty string.',
    );
  }

  const publicMetadataDefaults = validateMetadataDefaults(record['publicMetadataDefaults']);
  const waves = validateWaves(record['waves']);
  const leakPatterns = validateLeakPatterns(record['leakPatterns']);

  return {
    publicTreePath,
    publicMetadataDefaults,
    waves,
    ...(leakPatterns !== undefined ? { leakPatterns } : {}),
  };
}

/**
 * Validate the optional `leakPatterns` field. Returns `undefined` when
 * the field is absent — the scanner then falls back to
 * `DEFAULT_LEAK_PATTERNS`.
 */
function validateLeakPatterns(raw: unknown): readonly LeakPattern[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.invalidShape,
      '`leakPatterns` must be an array if defined.',
    );
  }
  const out: LeakPattern[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, 'Each leak pattern must be an object.');
    }
    const e = entry as Record<string, unknown>;
    const id = e['id'];
    const description = e['description'];
    const pattern = e['pattern'];
    const severity = e['severity'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, 'Leak pattern `id` must be a non-empty string.');
    }
    if (typeof description !== 'string') {
      throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, `Leak pattern \`${id}\` is missing \`description\`.`);
    }
    if (!(pattern instanceof RegExp)) {
      throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, `Leak pattern \`${id}\`.pattern must be a RegExp.`);
    }
    if (severity !== 'error' && severity !== 'warning') {
      throw new ReleaseConfigError(
        CONFIG_ERROR_CODES.invalidShape,
        `Leak pattern \`${id}\`.severity must be "error" or "warning".`,
      );
    }
    out.push({ id, description, pattern, severity });
  }
  return out;
}

function validateMetadataDefaults(raw: unknown): PublicMetadataDefaults {
  if (raw === null || typeof raw !== 'object') {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.missingField,
      'Config field `publicMetadataDefaults` must be an object.',
    );
  }
  const m = raw as Record<string, unknown>;
  const license = m['license'];
  const homepage = m['homepage'];
  const keywords = m['keywords'];
  const repository = m['repository'];
  const bugs = m['bugs'];
  const publishConfig = m['publishConfig'];

  if (typeof license !== 'string') {
    throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, '`publicMetadataDefaults.license` must be a string.');
  }
  if (typeof homepage !== 'string') {
    throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, '`publicMetadataDefaults.homepage` must be a string.');
  }
  if (!Array.isArray(keywords) || keywords.some(k => typeof k !== 'string')) {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.invalidShape,
      '`publicMetadataDefaults.keywords` must be a string[].',
    );
  }
  if (repository === null || typeof repository !== 'object') {
    throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, '`publicMetadataDefaults.repository` must be an object.');
  }
  const repoRec = repository as Record<string, unknown>;
  if (typeof repoRec['type'] !== 'string' || typeof repoRec['url'] !== 'string') {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.invalidShape,
      '`publicMetadataDefaults.repository` must have string `type` and `url`.',
    );
  }
  if (bugs === null || typeof bugs !== 'object') {
    throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, '`publicMetadataDefaults.bugs` must be an object.');
  }
  const bugsRec = bugs as Record<string, unknown>;
  if (typeof bugsRec['url'] !== 'string') {
    throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, '`publicMetadataDefaults.bugs.url` must be a string.');
  }
  if (publishConfig === null || typeof publishConfig !== 'object') {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.invalidShape,
      '`publicMetadataDefaults.publishConfig` must be an object.',
    );
  }
  const pcRec = publishConfig as Record<string, unknown>;
  const access = pcRec['access'];
  if (access !== 'public' && access !== 'restricted') {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.invalidShape,
      '`publicMetadataDefaults.publishConfig.access` must be "public" or "restricted".',
    );
  }

  return {
    license,
    repository: { type: repoRec['type'], url: repoRec['url'] },
    bugs: { url: bugsRec['url'] },
    homepage,
    publishConfig: { access },
    keywords: keywords as readonly string[],
  };
}

const VALID_WAVE_IDS: ReadonlySet<ReleaseWaveId> = new Set<ReleaseWaveId>([
  'foundation',
  'dot-kernel',
  'infrastructure-adapters',
  'frontend',
  'specialized',
]);

/**
 * User-defined type guard that narrows an arbitrary string to the
 * {@link ReleaseWaveId} union. The internal `as ReleaseWaveId` is a
 * contained, intentional cast — it's only used for the membership check
 * against {@link VALID_WAVE_IDS}.
 */
function isReleaseWaveId(v: string): v is ReleaseWaveId {
  return VALID_WAVE_IDS.has(v as ReleaseWaveId);
}

function validateWaves(raw: unknown): readonly ReleaseWave[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ReleaseConfigError(
      CONFIG_ERROR_CODES.missingField,
      '`waves` must be a non-empty array of release waves.',
    );
  }
  const seenPackages = new Map<string, ReleaseWaveId>();
  const result: ReleaseWave[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      throw new ReleaseConfigError(CONFIG_ERROR_CODES.invalidShape, 'Each wave must be an object.');
    }
    const rec = entry as Record<string, unknown>;
    const id = rec['id'];
    const label = rec['label'];
    const packages = rec['packages'];
    if (typeof id !== 'string' || !isReleaseWaveId(id)) {
      throw new ReleaseConfigError(
        CONFIG_ERROR_CODES.invalidShape,
        `Wave \`id\` must be one of: ${[...VALID_WAVE_IDS].join(', ')}.`,
      );
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new ReleaseConfigError(
        CONFIG_ERROR_CODES.invalidShape,
        `Wave \`${id}\` is missing a non-empty \`label\`.`,
      );
    }
    if (!Array.isArray(packages) || packages.some(p => typeof p !== 'string')) {
      throw new ReleaseConfigError(
        CONFIG_ERROR_CODES.invalidShape,
        `Wave \`${id}\` packages must be a string[].`,
      );
    }
    const narrowed = packages as readonly string[];
    for (const pkg of narrowed) {
      if (!pkg.startsWith('@arki/')) {
        throw new ReleaseConfigError(
          CONFIG_ERROR_CODES.invalidWavePackage,
          `Wave \`${id}\` lists \`${pkg}\` which is not an \`@arki/*\` package.`,
        );
      }
      const prior = seenPackages.get(pkg);
      if (prior !== undefined) {
        throw new ReleaseConfigError(
          CONFIG_ERROR_CODES.duplicatePackage,
          `Package \`${pkg}\` appears in both \`${prior}\` and \`${id}\` waves.`,
        );
      }
      seenPackages.set(pkg, id);
    }
    const buildOutput = rec['buildOutput'];
    if (buildOutput !== undefined && buildOutput !== 'dist' && buildOutput !== 'source') {
      throw new ReleaseConfigError(
        CONFIG_ERROR_CODES.invalidShape,
        `Wave \`${id}\` buildOutput must be 'dist' or 'source'.`,
      );
    }
    result.push({ id, label, packages: narrowed, ...(buildOutput === undefined ? {} : { buildOutput }) });
  }
  return result;
}
