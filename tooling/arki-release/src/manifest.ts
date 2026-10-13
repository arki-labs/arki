/**
 * Manifest materialization — turn a workspace `package.json` into a
 * publishable, npm-ready manifest.
 *
 * Inputs:
 *   - A {@link ParsedManifest} from a workspace package.
 *   - A {@link MaterializationContext} carrying:
 *       - Bun catalog tables (root `package.json`),
 *       - Public ARKI workspace versions (the release graph),
 *       - The private-ARKI set (publish-blockers from inventory),
 *       - Public metadata defaults (license/repo/bugs/homepage/keywords).
 *
 * Behaviour:
 *   - Replace `workspace:*` ARKI deps with concrete versions from the
 *     release graph (exact in `dependencies` / `optionalDependencies`,
 *     caret-ranged in `peerDependencies` per peer-dep convention).
 *   - Replace `catalog:` / `catalog:<name>` refs with the concrete
 *     semver pulled from the catalog tables.
 *   - Fail loudly via structured errors (returned, not thrown) on:
 *       - private ARKI deps     (RELEASE_E003 — fatal),
 *       - unresolvable workspace deps (RELEASE_E004 — fatal),
 *       - unresolved catalogs   (RELEASE_E005 — fatal),
 *       - missing description    (RELEASE_E006 — warning, stubbed),
 *       - input `private: true`  (RELEASE_E007 — fatal).
 *   - Strip `private`, `devDependencies`, `scripts`, `prettier`,
 *     `workspaces`, `packageManager`, `imports` from the published shape.
 *   - Merge `keywords` (input first, then defaults — deduplicated).
 *   - Merge `publishConfig` (input wins on conflict).
 *
 * Purity: no I/O, no globals. The function returns
 * {@link MaterializationResult}; the caller (Task 5) decides whether to
 * write to disk.
 */

import debugFactory from 'debug';

import { isCatalogRef, resolveCatalogRef } from './catalogs';
import type { ParsedManifest } from './inventory';
import type {
  MaterializationContext,
  MaterializationResult,
  PublishableManifest,
  ReleaseError,
} from './types';

const debug = debugFactory('arki:release:manifest');

/**
 * Stable error codes emitted by the manifest materializer.
 *
 * These are documented in the public-release plan (Task 3); downstream
 * gates and Task 7's scorecard match against these codes verbatim.
 */
export const MANIFEST_ERROR_CODES = {
  /** Manifest depends on a `@arki/*` package marked `private: true`. */
  privateArkiDependency: 'RELEASE_E003',
  /** `workspace:*` dep cannot be resolved — name not in the release graph. */
  unresolvableWorkspaceDep: 'RELEASE_E004',
  /** `catalog:` / `catalog:<name>` reference could not be resolved. */
  unresolvedCatalog: 'RELEASE_E005',
  /** Input manifest is missing a `description` — fallback stub applied. */
  missingDescription: 'RELEASE_E006',
  /** Input manifest has `private: true` — refuse to materialize for publish. */
  privateInput: 'RELEASE_E007',
} as const;

/** Which dependency bucket is being processed — affects peer-dep ranges. */
type DepBucket = 'dependencies' | 'peerDependencies' | 'optionalDependencies';

const WORKSPACE_PREFIX = 'workspace:';

/**
 * Materialize a publishable manifest for one workspace package.
 *
 * Pure. Returns the publish-ready manifest object **plus** every
 * resolution error in one pass — fatal errors do not short-circuit so a
 * single run can surface every problem.
 */
export function materializeManifest(
  input: ParsedManifest,
  ctx: MaterializationContext,
): MaterializationResult {
  debug('materializing %s@%s', input.name, input.version);
  const errors: ReleaseError[] = [];

  // Hard refusal — input marked private.
  if (input.private) {
    errors.push({
      code: MANIFEST_ERROR_CODES.privateInput,
      severity: 'error',
      message: `${input.name} is marked \`"private": true\` and cannot be materialized for publish.`,
      target: input.name,
      remediation:
        'Drop the `private` flag in its package.json once the package is publish-ready, or remove it from the wave allowlist.',
    });
  }

  const inputRaw = readManifestRaw(input);

  const dependencies = resolveBucket(
    'dependencies',
    inputRaw.dependencies ?? input.dependencies,
    ctx,
    input.name,
    errors,
  );
  // Optional peers don't taint the publish graph — a consumer chooses
  // whether to install them. Pass the meta so `resolveBucket` can skip
  // the private-dep check on those entries.
  const peerMeta = inputRaw.peerDependenciesMeta ?? input.peerDependenciesMeta;
  const peerDependencies = resolveBucket(
    'peerDependencies',
    inputRaw.peerDependencies ?? input.peerDependencies,
    ctx,
    input.name,
    errors,
    peerMeta,
  );
  const optionalDependencies = resolveBucket(
    'optionalDependencies',
    inputRaw.optionalDependencies ?? input.optionalDependencies,
    ctx,
    input.name,
    errors,
  );

  const description = resolveDescription(input.name, inputRaw.description, errors);

  const keywords = mergeKeywords(inputRaw.keywords, ctx.metadataDefaults.keywords);

  const repository = pickRepository(inputRaw.repository, ctx);
  const bugs = pickBugs(inputRaw.bugs, ctx);
  const homepage = pickString(inputRaw.homepage, ctx.metadataDefaults.homepage);
  const license = pickString(inputRaw.license, ctx.metadataDefaults.license);
  const publishConfig = mergePublishConfig(inputRaw.publishConfig, ctx);

  const manifest: PublishableManifest = {
    name: input.name,
    version: input.version,
    description,
    license,
    repository,
    homepage,
    bugs,
    keywords,
    publishConfig,
    ...(inputRaw.type !== undefined ? { type: inputRaw.type } : {}),
    ...(inputRaw.sideEffects !== undefined ? { sideEffects: inputRaw.sideEffects } : {}),
    ...(inputRaw.exports !== undefined ? { exports: inputRaw.exports } : {}),
    ...(inputRaw.main !== undefined ? { main: inputRaw.main } : {}),
    ...(inputRaw.module !== undefined ? { module: inputRaw.module } : {}),
    ...(inputRaw.types !== undefined ? { types: inputRaw.types } : {}),
    ...(inputRaw.files !== undefined ? { files: inputRaw.files } : {}),
    ...(inputRaw.bin !== undefined ? { bin: inputRaw.bin } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
    ...(peerDependencies !== undefined ? { peerDependencies } : {}),
    ...(optionalDependencies !== undefined ? { optionalDependencies } : {}),
    ...(inputRaw.peerDependenciesMeta !== undefined
      ? { peerDependenciesMeta: inputRaw.peerDependenciesMeta }
      : {}),
    ...(inputRaw.bundleDependencies !== undefined
      ? { bundleDependencies: inputRaw.bundleDependencies }
      : {}),
    ...(inputRaw.engines !== undefined ? { engines: inputRaw.engines } : {}),
  };

  return { manifest, errors };
}

/**
 * Narrow the parsed manifest's surface area to the publishable shape.
 *
 * {@link ParsedManifest} (from `inventory.ts`) intentionally only exposes
 * the fields the inventory pass cares about. The materializer needs more
 * surface — but we don't want to widen the inventory contract just for
 * Task 3. Instead, we re-read the file's "extras" off a side-channel
 * field on the parsed manifest. Tests can attach this side channel
 * directly; the inventory loader (Task 2) will be extended to populate it
 * when Task 5 wires the materializer into the pipeline.
 *
 * Until then, callers who only pass a `ParsedManifest` get a conservative
 * subset — `dependencies` / `peerDependencies` / `optionalDependencies`
 * are read from the inventory fields directly.
 *
 * The "raw" view returned here represents the publish-relevant fields
 * we need to copy through unchanged.
 */
interface ManifestRaw {
  readonly description?: string;
  readonly type?: 'module' | 'commonjs';
  readonly sideEffects?: boolean | readonly string[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly files?: readonly string[];
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly keywords?: readonly string[];
  readonly repository?: { readonly type: string; readonly url: string };
  readonly bugs?: { readonly url: string };
  readonly homepage?: string;
  readonly license?: string;
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly bundleDependencies?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/**
 * Read the publish-relevant "extras" attached to a parsed manifest.
 *
 * The materializer is wired up before Task 5 extends the inventory loader,
 * so this guards every field defensively. Tests construct fixtures by
 * casting an extended object to `ParsedManifest` — the cast is local to
 * the test file and intentional.
 */
function readManifestRaw(input: ParsedManifest): ManifestRaw {
  const raw = input as ParsedManifest & Partial<ManifestRaw>;
  return {
    description: typeof raw.description === 'string' ? raw.description : undefined,
    type: raw.type === 'module' || raw.type === 'commonjs' ? raw.type : undefined,
    sideEffects: raw.sideEffects,
    exports: raw.exports,
    main: typeof raw.main === 'string' ? raw.main : undefined,
    module: typeof raw.module === 'string' ? raw.module : undefined,
    types: typeof raw.types === 'string' ? raw.types : undefined,
    files: Array.isArray(raw.files) ? (raw.files as readonly string[]) : undefined,
    bin: raw.bin,
    keywords: Array.isArray(raw.keywords) ? (raw.keywords as readonly string[]) : undefined,
    repository: raw.repository,
    bugs: raw.bugs,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    license: typeof raw.license === 'string' ? raw.license : undefined,
    publishConfig: raw.publishConfig,
    peerDependenciesMeta: raw.peerDependenciesMeta,
    bundleDependencies: Array.isArray(raw.bundleDependencies)
      ? (raw.bundleDependencies as readonly string[])
      : undefined,
    engines: raw.engines,
    dependencies: raw.dependencies,
    peerDependencies: raw.peerDependencies,
    optionalDependencies: raw.optionalDependencies,
  };
}

/**
 * Resolve every entry in a single dep bucket. Returns `undefined` (so the
 * field is omitted from the published manifest) when there are no
 * entries; otherwise an entry map of `pkgName → concreteVersion`.
 *
 * Unresolved entries are dropped from the output **but** error records are
 * pushed onto `errors` so the caller refuses to publish. Dropping the
 * entry — rather than leaving a `workspace:*` placeholder in the output —
 * prevents accidental publish of an unresolvable manifest if a downstream
 * caller ever ignores the errors array. The fatal error is the source of
 * truth, not the resolved object.
 */
function resolveBucket(
  bucket: DepBucket,
  raw: Readonly<Record<string, string>> | undefined,
  ctx: MaterializationContext,
  consumerName: string,
  errors: ReleaseError[],
  peerMeta?: Readonly<Record<string, { readonly optional?: boolean }>>,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;

  const out: Record<string, string> = {};
  for (const [depName, version] of entries) {
    if (version.startsWith(WORKSPACE_PREFIX)) {
      const isOptionalPeer =
        bucket === 'peerDependencies' && peerMeta?.[depName]?.optional === true;
      const resolved = resolveWorkspaceDep(
        depName,
        consumerName,
        bucket,
        ctx,
        errors,
        isOptionalPeer,
      );
      if (resolved !== null) {
        out[depName] = resolved;
      }
      continue;
    }
    if (isCatalogRef(version)) {
      const result = resolveCatalogRef(version, depName, ctx.catalogs);
      if ('resolved' in result) {
        out[depName] = result.resolved;
      } else {
        errors.push(result.error);
      }
      continue;
    }
    // Plain semver / git / file / npm-tag — pass through.
    out[depName] = version;
  }

  if (Object.keys(out).length === 0) return undefined;
  return out;
}

/**
 * Resolve a single `workspace:*` (or `workspace:^`, `workspace:~`,
 * `workspace:^1.2.3`, etc.) dep against the release graph.
 *
 * Returns `null` and pushes a fatal error onto `errors` when:
 *   - the dep is not in the workspace versions map (RELEASE_E004),
 *   - or the dep IS an ARKI workspace package but marked private
 *     (RELEASE_E003).
 *
 * Otherwise returns the concrete version: exact (`X.Y.Z`) for
 * `dependencies` / `optionalDependencies`, caret-ranged (`^X.Y.Z`) for
 * `peerDependencies`.
 */
function resolveWorkspaceDep(
  depName: string,
  consumerName: string,
  bucket: DepBucket,
  ctx: MaterializationContext,
  errors: ReleaseError[],
  isOptionalPeer = false,
): string | null {
  if (ctx.privateArkiPackages.has(depName)) {
    if (isOptionalPeer) {
      // Optional peers are runtime capabilities the consumer opts into.
      // They do not block publishing — the consumer is responsible for
      // installing the dep only when they need it. Drop the entry from
      // the resolved bucket and emit no error.
      return null;
    }
    errors.push({
      code: MANIFEST_ERROR_CODES.privateArkiDependency,
      severity: 'error',
      message: `${consumerName} depends on private package ${depName}; cannot materialize for publish.`,
      target: depName,
      remediation: `Promote ${depName} to public first (Task 8), or remove the dependency.`,
    });
    return null;
  }

  const version = ctx.workspaceVersions.get(depName);
  if (typeof version !== 'string' || version.length === 0) {
    errors.push({
      code: MANIFEST_ERROR_CODES.unresolvableWorkspaceDep,
      severity: 'error',
      message: `${consumerName} depends on ${depName} via \`workspace:*\` but no version is available in the release graph.`,
      target: depName,
      remediation: `Add ${depName} to the release graph (workspaceVersions) or remove the dependency.`,
    });
    return null;
  }

  if (bucket === 'peerDependencies') {
    return `^${version}`;
  }
  return version;
}

/**
 * Choose an effective description for the publishable manifest.
 *
 * If the input has one, use it. If not, emit RELEASE_E006 (warning, not
 * error) and fall back to a generic stub so the package can still publish.
 * Task 8 fills in human-written descriptions per-package.
 */
function resolveDescription(
  name: string,
  inputDescription: string | undefined,
  errors: ReleaseError[],
): string {
  if (typeof inputDescription === 'string' && inputDescription.trim().length > 0) {
    return inputDescription;
  }
  errors.push({
    code: MANIFEST_ERROR_CODES.missingDescription,
    severity: 'warning',
    message: `${name} has no \`description\` — using a generic stub for now.`,
    target: name,
    remediation: 'Add a `"description"` field to the package.json before the public publish (Task 8).',
  });
  return `ARKI library: ${name}`;
}

/**
 * Merge keywords from input + defaults, preserving order and removing
 * duplicates. Input wins for ordering ("the package owns its identity"),
 * defaults fill in the rest ("arki", "typescript", etc.).
 */
function mergeKeywords(
  inputKeywords: readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const source: readonly string[] = inputKeywords ?? [];
  for (const k of source) {
    if (typeof k !== 'string') continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  for (const k of defaults) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Repository: input overrides default. */
function pickRepository(
  input: { readonly type: string; readonly url: string } | undefined,
  ctx: MaterializationContext,
): { readonly type: string; readonly url: string } {
  if (input !== undefined) {
    return { type: input.type, url: input.url };
  }
  return { type: ctx.metadataDefaults.repository.type, url: ctx.metadataDefaults.repository.url };
}

/** Bugs: input overrides default. */
function pickBugs(
  input: { readonly url: string } | undefined,
  ctx: MaterializationContext,
): { readonly url: string } {
  if (input !== undefined) {
    return { url: input.url };
  }
  return { url: ctx.metadataDefaults.bugs.url };
}

/** Scalar default fallback — input wins when defined and non-empty. */
function pickString(input: string | undefined, fallback: string): string {
  if (typeof input === 'string' && input.length > 0) return input;
  return fallback;
}

/**
 * Merge publishConfig: defaults provide the floor, input overrides on
 * conflict. Always include `access: 'public'` from defaults unless the
 * input has explicitly overridden it.
 */
function mergePublishConfig(
  input: Readonly<Record<string, unknown>> | undefined,
  ctx: MaterializationContext,
): Readonly<Record<string, unknown>> {
  const merged: Record<string, unknown> = { ...ctx.metadataDefaults.publishConfig };
  if (input !== undefined) {
    for (const [k, v] of Object.entries(input)) {
      merged[k] = v;
    }
  }
  return merged;
}
