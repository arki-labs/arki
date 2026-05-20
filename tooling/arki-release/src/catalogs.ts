/**
 * Catalog resolution for the release pipeline.
 *
 * Bun catalogs centralize dependency versions in the root `package.json`:
 *
 *   - `"catalog"` is the **default** catalog — referenced from package
 *     manifests as `"catalog:"`. Map: `pkgName → semver`.
 *   - `"catalogs"` is a map of **named** catalogs — referenced as
 *     `"catalog:<name>"`. Map: `catalogName → { pkgName → semver }`.
 *
 * The materializer (Task 3) replaces every `catalog:` reference with the
 * concrete semver looked up from these tables. This module owns:
 *
 *   - {@link loadCatalogs}: validate + freeze the catalog tables out of a
 *     parsed root `package.json`. No I/O — accepts an already-parsed
 *     `unknown` value so it is unit-testable.
 *   - {@link resolveCatalogRef}: parse a single `catalog:` reference and
 *     look up the concrete semver. Returns either the resolved version or
 *     a structured {@link ReleaseError}.
 *
 * Both helpers are pure. Validation errors throw {@link CatalogLoadError}
 * — the caller (CLI entrypoint) catches and converts to a failure
 * envelope, same pattern as `ReleaseConfigError`.
 */

import debugFactory from 'debug';

import type { CatalogTables, ReleaseError } from './types';

const debug = debugFactory('arki:release:catalogs');

/** Stable error codes emitted by this module. */
export const CATALOG_ERROR_CODES = {
  /** Root manifest is not an object / missing both catalog sections. */
  malformedRoot: 'CAT_E001',
  /** `catalog` is present but is not a plain object of strings. */
  invalidDefaultCatalog: 'CAT_E002',
  /** `catalogs` is present but is not a plain object of objects of strings. */
  invalidNamedCatalogs: 'CAT_E003',
  /** A `catalog:<name>` reference points at a catalog that does not exist. */
  unknownCatalog: 'RELEASE_E005',
  /** A `catalog:` or `catalog:<name>` reference's package is not in the catalog. */
  unresolvedCatalogEntry: 'RELEASE_E005',
} as const;

/** Thrown when the root manifest's catalog shape is invalid. */
export class CatalogLoadError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CatalogLoadError';
  }
}

const CATALOG_PREFIX = 'catalog:';

/**
 * Extract the `catalog` (default) and `catalogs` (named) tables from a
 * parsed root `package.json`. Validates the shape and freezes the result.
 *
 * Both catalog sections are optional — a workspace with no `catalog`
 * section returns `{ default: {}, named: {} }`. The materializer treats
 * those as "no catalog references resolvable", which surfaces every
 * dangling `catalog:` ref as a `RELEASE_E005` instead of silently
 * dropping the dep.
 */
export function loadCatalogs(rootPackageJson: unknown): CatalogTables {
  debug('loading catalogs from root package.json');
  if (rootPackageJson === null || typeof rootPackageJson !== 'object') {
    throw new CatalogLoadError(
      CATALOG_ERROR_CODES.malformedRoot,
      'Root package.json must be a JSON object.',
    );
  }
  const record = rootPackageJson as Record<string, unknown>;

  const defaultCatalog = parseDefaultCatalog(record['catalog']);
  const namedCatalogs = parseNamedCatalogs(record['catalogs']);

  return {
    default: Object.freeze(defaultCatalog),
    named: Object.freeze(namedCatalogs),
  };
}

function parseDefaultCatalog(raw: unknown): Readonly<Record<string, string>> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CatalogLoadError(
      CATALOG_ERROR_CODES.invalidDefaultCatalog,
      'Root `catalog` field must be an object mapping package names to semver strings.',
    );
  }
  const out: Record<string, string> = {};
  for (const [pkgName, version] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof version !== 'string' || version.length === 0) {
      throw new CatalogLoadError(
        CATALOG_ERROR_CODES.invalidDefaultCatalog,
        `Root catalog entry \`${pkgName}\` must be a non-empty string (got ${typeof version}).`,
      );
    }
    out[pkgName] = version;
  }
  return out;
}

function parseNamedCatalogs(
  raw: unknown,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CatalogLoadError(
      CATALOG_ERROR_CODES.invalidNamedCatalogs,
      'Root `catalogs` field must be an object mapping catalog names to entry objects.',
    );
  }
  const out: Record<string, Readonly<Record<string, string>>> = {};
  for (const [catalogName, table] of Object.entries(raw as Record<string, unknown>)) {
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
      throw new CatalogLoadError(
        CATALOG_ERROR_CODES.invalidNamedCatalogs,
        `Named catalog \`${catalogName}\` must be an object mapping package names to semver strings.`,
      );
    }
    const inner: Record<string, string> = {};
    for (const [pkgName, version] of Object.entries(table as Record<string, unknown>)) {
      if (typeof version !== 'string' || version.length === 0) {
        throw new CatalogLoadError(
          CATALOG_ERROR_CODES.invalidNamedCatalogs,
          `Named catalog \`${catalogName}\` entry \`${pkgName}\` must be a non-empty string (got ${typeof version}).`,
        );
      }
      inner[pkgName] = version;
    }
    out[catalogName] = Object.freeze(inner);
  }
  return out;
}

/**
 * Outcome of resolving a single `catalog:` reference.
 *
 * The discriminated union keeps callers honest — they must pattern-match
 * on `resolved` vs `error`. Returning a {@link ReleaseError} (rather than
 * throwing) lets the materializer collect multiple problems before
 * giving up on a manifest.
 */
export type ResolveCatalogResult =
  | { readonly resolved: string }
  | { readonly error: ReleaseError };

/**
 * Resolve a catalog reference (e.g. `"catalog:"` or `"catalog:env"`) for
 * a given package name against the supplied catalog tables.
 *
 * - `"catalog:"`        → look up `catalogs.default[pkgName]`.
 * - `"catalog:<name>"`  → look up `catalogs.named[<name>][pkgName]`.
 *
 * Any other input is a programmer error — callers should only invoke this
 * when {@link isCatalogRef} returns `true`. We still defend by returning a
 * structured error rather than throwing.
 */
export function resolveCatalogRef(
  ref: string,
  pkgName: string,
  catalogs: CatalogTables,
): ResolveCatalogResult {
  if (!ref.startsWith(CATALOG_PREFIX)) {
    return {
      error: {
        code: CATALOG_ERROR_CODES.unresolvedCatalogEntry,
        severity: 'error',
        message: `Internal: resolveCatalogRef called with non-catalog ref \`${ref}\` for ${pkgName}.`,
        target: pkgName,
      },
    };
  }
  const suffix = ref.slice(CATALOG_PREFIX.length);
  if (suffix.length === 0) {
    // Default catalog.
    const found = catalogs.default[pkgName];
    if (typeof found !== 'string') {
      return {
        error: {
          code: CATALOG_ERROR_CODES.unresolvedCatalogEntry,
          severity: 'error',
          message: `Default catalog has no entry for \`${pkgName}\` (referenced as \`catalog:\`).`,
          target: pkgName,
          remediation: `Add \`"${pkgName}": "<semver>"\` to the root package.json \`catalog\` block.`,
        },
      };
    }
    return { resolved: found };
  }

  // Named catalog.
  const table = catalogs.named[suffix];
  if (table === undefined) {
    return {
      error: {
        code: CATALOG_ERROR_CODES.unknownCatalog,
        severity: 'error',
        message: `Catalog \`${suffix}\` referenced by ${pkgName} does not exist in the root package.json.`,
        target: pkgName,
        remediation: `Add \`"${suffix}": { ... }\` to the root package.json \`catalogs\` block, or change the reference to an existing catalog.`,
      },
    };
  }
  const found = table[pkgName];
  if (typeof found !== 'string') {
    return {
      error: {
        code: CATALOG_ERROR_CODES.unresolvedCatalogEntry,
        severity: 'error',
        message: `Catalog \`${suffix}\` has no entry for \`${pkgName}\`.`,
        target: pkgName,
        remediation: `Add \`"${pkgName}": "<semver>"\` to the \`catalogs.${suffix}\` block in the root package.json.`,
      },
    };
  }
  return { resolved: found };
}

/** Convenience predicate — true if `version` is a `catalog:` reference. */
export function isCatalogRef(version: string): boolean {
  return version.startsWith(CATALOG_PREFIX);
}
