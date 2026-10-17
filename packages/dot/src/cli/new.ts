/**
 * `dot new <app>` — scaffold a DOT app from a bundled template.
 *
 * Two templates ship with the package (`--template <name>`):
 *
 *   - `stack` (default) — a full-stack app: TanStack Start + oRPC +
 *     Drizzle/Postgres via `@arki/db` + `@arki/journal`, composed with
 *     `@arki/dot`, styled with `@arki/ui` and the workbench design system.
 *   - `minimal` — the smallest DOT app: `defineApp` + `@arki/env`.
 *
 * Two-phase: we first build an in-memory list of {@link FileOperation}
 * entries describing every file the scaffold WOULD write (template
 * substitution included), then either:
 *
 *   - `--dry-run` -> return the plan, write nothing.
 *   - real run    -> commit the planned operations to disk.
 *
 * The dry-run result is the contract: agents read `.data.operations[]` to
 * know exactly which files will land, with sha256 hashes so they can verify
 * the post-run filesystem matches the plan.
 *
 * Templates live at `packages/dot/templates/app-<name>/` and use
 * `.tmpl` suffixes + `{{name}}`-style placeholders. The suffix is
 * stripped during scaffolding so `package.json.tmpl` becomes
 * `package.json` on disk.
 *
 * Commands deferred to v1.1 (`dot add <plugin>`, `dot migrate`) are
 * deliberately NOT surfaced here.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Failure } from '@arki/failure';
import { InvalidInput } from '@arki/cli';
import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { FileOperation } from './files.js';
import type { DotNewResult } from './json.js';
import { TargetNotEmpty, TemplateMissing, WriteFailed } from './failures.js';
import {
  collectTemplateFiles,
  directoryIsNonEmpty,
  fileExists,
  readTemplate,
  sha256,
  utf8ByteLength,
  writeFileEnsuringDir,
} from './files.js';
import { toPublicOperation } from './json.js';
import { readDotVersion, TEMPLATE_VERSIONS, ZOD_VERSION } from './versions.js';

const debugNew = getLogger('arki:dot:cli:new');

/**
 * Package manager the generated README + AGENTS.md will reference.
 * `bun` is the default because the kernel + adapter packages are tested
 * with Bun first.
 */
export type PackageManager = 'npm' | 'pnpm' | 'bun';

/** Template names accepted by `--template`. */
export const TEMPLATE_NAMES = ['stack', 'minimal'] as const;

/** A bundled template. */
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** The template `dot new` uses when `--template` is omitted. */
export const DEFAULT_TEMPLATE: TemplateName = 'stack';

/** What {@link planOperations} returns: every file the scaffold would write, and where. */
export type NewPlan = {
  readonly operations: FileOperation[];
  readonly target: string;
};

/** Options accepted by {@link runNew}. */
export type RunNewOptions = {
  /** Application name (becomes `package.json#name`). */
  readonly name: string;
  /**
   * Working directory for resolving `--target`. Defaults to
   * `process.cwd()` when omitted.
   */
  readonly cwd?: string;
  /**
   * Target directory; resolved against `cwd`. Defaults to `<name>`
   * under `cwd`. The directory is created if missing.
   */
  readonly target?: string;
  /** Package manager hint surfaced in README/AGENTS.md. Defaults to `bun`. */
  readonly pm?: PackageManager;
  /**
   * Bundled template to scaffold (`stack` or `minimal`). Defaults to
   * {@link DEFAULT_TEMPLATE}. Any other value fails with `cli.invalid_input`.
   */
  readonly template?: string;
  /** When true, only plan operations — write nothing. */
  readonly dryRun?: boolean;
  /** When true, overwrite existing files in the target dir. */
  readonly force?: boolean;
  /**
   * Override template root. Used by tests; production callers should
   * leave this undefined so the bundled `templates/app-<template>/`
   * directory is used.
   */
  readonly templateRoot?: string;
  /**
   * Version values inlined into the generated `package.json`. `dot`
   * defaults to this package's own version; the others default to
   * {@link TEMPLATE_VERSIONS} (see `versions.ts`).
   */
  readonly versions?: {
    readonly dot?: string;
    readonly env?: string;
    readonly zod?: string;
    readonly log?: string;
    readonly db?: string;
    readonly journal?: string;
    readonly ui?: string;
    readonly designSystems?: string;
  };
};

export const DEFAULT_PM: PackageManager = 'bun';

const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const MINIMAL_FILE_REASONS: Record<string, string> = {
  'package.json': 'Package manifest with @arki/dot + @arki/env dependencies',
  'tsconfig.json': 'TypeScript config for ESM + NodeNext + strict mode',
  'README.md': 'Quickstart and inspection commands',
  'AGENTS.md': 'Agent-readable conventions (verification commands, public/private boundaries, DOT artifact locations)',
  '.gitignore': 'Standard ignores for node_modules, dist, env files',
  'src/app.ts': 'App entrypoint composing defineApp + env adapter',
  'src/env.ts': 'Env schema (zod) consumed by @arki/env/dot',
  'tests/boot.test.ts': 'Vitest that boots the app and asserts manifest shape',
};

const STACK_FILE_REASONS: Record<string, string> = {
  'package.json': 'Package manifest: TanStack Start, oRPC, @arki/dot, @arki/db, @arki/journal, @arki/ui',
  'tsconfig.json': 'Strict TypeScript config for the whole app',
  'README.md': 'Run locally, deploy to Coolify, what comes next',
  'AGENTS.md': 'Agent guide: where features live, how to add one, dot explain / dot doctor',
  '.gitignore': 'Ignores for node_modules, build output, env files',
  '.dockerignore': 'Keeps node_modules, build output and env files out of the Docker context',
  '.env.example': 'Env vars the app reads, with local defaults',
  Dockerfile: 'Multi-stage Bun image that builds and serves the Nitro output',
  'docker-compose.yml': 'Postgres for local development',
  'drizzle.config.ts': 'drizzle-kit config: schema files and migrations folder',
  'vite.config.ts': 'Vite + TanStack Start + Nitro + Tailwind',
  'vitest.config.ts': 'Vitest config (tests use in-memory PGlite, no Docker)',
  'src/app.ts': 'The DOT app: log, env, db, migrations, journal',
  'src/env.ts': 'Env schema (zod) consumed by @arki/env/dot',
};

const FILE_REASONS: Record<TemplateName, Record<string, string>> = {
  stack: STACK_FILE_REASONS,
  minimal: MINIMAL_FILE_REASONS,
};

const TEMPLATE_SUFFIX = '.tmpl';

/**
 * Template files stored under a different name than they are written as.
 * The published tarball must not contain any `.env*` file (the release
 * packlist rejects them, so secrets can never ship by accident), so the
 * example env file lives in the template as `env.example`.
 */
const WRITTEN_AS: Record<string, string> = {
  'env.example': '.env.example',
};

/**
 * Resolve a bundled template directory, anchored relative to this source
 * file. Works both when running from `src/` under Bun and from `dist/`
 * after `tsc` — both layouts put the templates directory two levels above
 * (`packages/dot/templates/app-<name>`).
 */
function defaultTemplateRoot(template: TemplateName): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'templates', `app-${template}`);
}

function isTemplateName(value: string): value is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(value);
}

/**
 * The template a `--template` value names: omitted means
 * {@link DEFAULT_TEMPLATE}; an unknown name is `undefined`.
 */
export function resolveTemplateName(value: string | undefined): TemplateName | undefined {
  if (value === undefined) return DEFAULT_TEMPLATE;
  return isTemplateName(value) ? value : undefined;
}

/**
 * Resolve the absolute target path for a given app + options bundle.
 * Exported so tests can assert resolution behaviour without running the
 * full scaffold.
 */
export function resolveTargetDir(opts: { name: string; cwd?: string; target?: string }): string {
  const cwd = opts.cwd ?? process.cwd();
  const target = opts.target ?? opts.name;
  return path.resolve(cwd, target);
}

/**
 * What is wrong with an app name, or `undefined` when it is valid. Rules
 * match `package.json#name` constraints (lower-case, leading alphanumeric,
 * no spaces) with one extra: scoped names are refused so the scaffold
 * produces a single-segment dir. The `name` schema of `dot new` calls it.
 */
export function validateAppName(name: string): string | undefined {
  if (!name) return 'App name is required: `dot new <app-name>`.';
  if (!APP_NAME_PATTERN.test(name)) {
    return `App name "${name}" is invalid: use lowercase letters, digits, dots, hyphens, or underscores, starting with a letter or digit (no \`@scope/\` names).`;
  }
  return undefined;
}

function describeFile(template: TemplateName, relativePath: string): string {
  return FILE_REASONS[template][relativePath] ?? `Scaffold file: ${relativePath}`;
}

function substitute(content: string, vars: Record<string, string>): string {
  return content.replaceAll(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key]!;
    }
    return `{{${key}}}`;
  });
}

/**
 * Plan the file operations for a scaffold run. Pure — does not touch
 * disk other than reading templates and `stat`-ing target paths.
 */
export async function planOperations(opts: RunNewOptions): Promise<NewPlan | Failure> {
  const nameProblem = validateAppName(opts.name);
  if (nameProblem !== undefined)
    return InvalidInput({ issues: [{ path: ['name'], flag: '<name>', message: nameProblem }] });
  const template = resolveTemplateName(opts.template);
  if (template === undefined) {
    const message = `Unknown template "${opts.template ?? ''}": use one of ${TEMPLATE_NAMES.join(', ')}.`;
    return InvalidInput({ issues: [{ path: ['template'], flag: '--template', message }] });
  }
  const target = resolveTargetDir(opts);
  const templateRoot = opts.templateRoot ?? defaultTemplateRoot(template);
  const pm = opts.pm ?? DEFAULT_PM;

  const templateFiles = await collectTemplateFiles(templateRoot);
  if (templateFiles.length === 0) return TemplateMissing({ templateRoot });

  const vars: Record<string, string> = {
    name: opts.name,
    pkgManager: pm,
    dotVersion: opts.versions?.dot ?? readDotVersion(),
    envVersion: opts.versions?.env ?? TEMPLATE_VERSIONS.env,
    zodVersion: opts.versions?.zod ?? ZOD_VERSION,
    logVersion: opts.versions?.log ?? TEMPLATE_VERSIONS.log,
    dbVersion: opts.versions?.db ?? TEMPLATE_VERSIONS.db,
    journalVersion: opts.versions?.journal ?? TEMPLATE_VERSIONS.journal,
    uiVersion: opts.versions?.ui ?? TEMPLATE_VERSIONS.ui,
    designSystemsVersion: opts.versions?.designSystems ?? TEMPLATE_VERSIONS['design-systems'],
  };

  const operations: FileOperation[] = [];
  for (const templateRelPath of templateFiles) {
    const absoluteTemplate = path.join(templateRoot, templateRelPath);
    const raw = await readTemplate(absoluteTemplate);
    const rendered = substitute(raw, vars);

    const withoutSuffix = templateRelPath.endsWith(TEMPLATE_SUFFIX)
      ? templateRelPath.slice(0, -TEMPLATE_SUFFIX.length)
      : templateRelPath;
    const stripped = WRITTEN_AS[withoutSuffix] ?? withoutSuffix;
    const targetPath = path.join(target, stripped);
    const exists = await fileExists(targetPath);

    let action: FileOperation['action'];
    if (!exists) {
      action = 'create';
    } else if (opts.force) {
      action = 'overwrite';
    } else {
      action = 'skip';
    }

    operations.push({
      path: stripped,
      action,
      contentHash: sha256(rendered),
      contentBytes: utf8ByteLength(rendered),
      reason: describeFile(template, stripped),
      content: rendered,
    });
  }

  // Deterministic, sorted output regardless of fs walk order.
  operations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { operations, target };
}

/** The commands to run after scaffolding, from the target's parent directory. */
function nextStepsOf(opts: RunNewOptions, target: string): string[] {
  const pm = opts.pm ?? DEFAULT_PM;
  const relativeTarget = path.relative(opts.cwd ?? process.cwd(), target) || '.';
  const start = [`cd ${relativeTarget}`, `${pm} install`];
  return resolveTemplateName(opts.template) === 'stack'
    ? [...start, 'cp .env.example .env', 'docker compose up -d', `${pm} run dev`]
    : [...start, `${pm} run test`];
}

function resultOf(opts: RunNewOptions, target: string, operations: readonly FileOperation[]): DotNewResult {
  return {
    app: { name: opts.name, target },
    operations: operations.map(op => toPublicOperation(op)),
    nextSteps: nextStepsOf(opts, target),
  };
}

/**
 * Run `dot new`: plan, then write unless `dryRun`. Returns `{ app, operations }`
 * or a failure: `cli.invalid_input` (name, template), `dot.target_not_empty`,
 * `dot.template_missing`, `dot.write_failed`. Prints nothing.
 */
export async function runNew(opts: RunNewOptions): Promise<DotNewResult | Failure> {
  const plan = await planOperations(opts);
  if (isFailure(plan)) return plan;
  const { operations, target } = plan;

  if (opts.dryRun) return resultOf(opts, target, operations);

  // Refuse to overwrite a non-empty target dir unless --force.
  if (!opts.force) {
    const conflicting = operations.filter(op => op.action === 'skip').map(op => op.path);
    if (conflicting.length > 0 || (await directoryIsNonEmpty(target))) {
      return TargetNotEmpty({ target, conflicting });
    }
  }

  const written: FileOperation[] = [];
  const failed: { path: string; message: string }[] = [];
  for (const op of operations) {
    try {
      await writeFileEnsuringDir(path.join(target, op.path), op.content);
      written.push(op);
    } catch (error) {
      debugNew.debug('write failed for {path}', {
        path: op.path,
        error: error instanceof Error ? error : String(error),
      });
      failed.push({ path: op.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length > 0) {
    return WriteFailed({ target, written: written.map(op => toPublicOperation(op)), failed });
  }
  return resultOf(opts, target, written);
}
