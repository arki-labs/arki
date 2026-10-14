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
 *   - `--dry-run` -> print the JSON envelope, write nothing.
 *   - real run    -> commit the planned operations to disk.
 *
 * The dry-run envelope is the contract: agents read it to know exactly
 * which files will land, with sha256 hashes so they can verify the
 * post-run filesystem matches the plan.
 *
 * Templates live at `packages/dot/templates/app-<name>/` and use
 * `.tmpl` suffixes + `{{name}}`-style placeholders. The suffix is
 * stripped during scaffolding so `package.json.tmpl` becomes
 * `package.json` on disk.
 *
 * Commands deferred to v1.1 (`dot add <plugin>`, `dot dev`,
 * `dot migrate`) are deliberately NOT surfaced here.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogger } from '@arki/log';

import type { DiagnosticIssue } from '../diagnostics.js';
import type { FileOperation } from './files.js';
import type { DotNewEnvelope } from './json.js';
import { DotCliError, DotCliErrorCode } from './error-codes.js';
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
   * {@link DEFAULT_TEMPLATE}. Any other value fails with `DOT_CLI_E005`.
   */
  readonly template?: string;
  /** When true, only plan operations — write nothing. */
  readonly dryRun?: boolean;
  /** When true, emit JSON to `out`. Otherwise emit progress lines. */
  readonly json?: boolean;
  /** When true, overwrite existing files in the target dir. */
  readonly force?: boolean;
  /** Stdout sink. Defaults to `process.stdout.write`. */
  readonly out?: (line: string) => void;
  /** Stderr sink. Defaults to `process.stderr.write`. */
  readonly err?: (line: string) => void;
  /** Override clock for deterministic envelopes. */
  readonly now?: () => Date;
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

const DEFAULT_PM: PackageManager = 'bun';

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
 * Validate a `--template` value. Omitted means {@link DEFAULT_TEMPLATE}.
 * Exported so tests can assert the error without running a scaffold.
 */
export function resolveTemplateName(value: string | undefined): TemplateName {
  if (value === undefined) return DEFAULT_TEMPLATE;
  if (isTemplateName(value)) return value;
  throw new DotCliError({
    code: DotCliErrorCode.InvalidArgs,
    message: `Unknown template "${value}".`,
    remediation: `Use one of: ${TEMPLATE_NAMES.join(', ')}. Omit --template for the default (${DEFAULT_TEMPLATE}).`,
    metadata: { received: value, allowed: [...TEMPLATE_NAMES] },
  });
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
 * Validate an app name. Rules match `package.json#name` constraints
 * (lower-case, leading alphanumeric, no spaces) with one extra: we
 * disallow scoped names so the scaffold produces a single-segment dir.
 */
export function validateAppName(name: string): void {
  if (!name) {
    throw new DotCliError({
      code: DotCliErrorCode.InvalidArgs,
      message: 'App name is required.',
      remediation: 'Pass an app name: `dot new <app-name>`.',
    });
  }
  if (!APP_NAME_PATTERN.test(name)) {
    throw new DotCliError({
      code: DotCliErrorCode.InvalidArgs,
      message: `App name "${name}" is invalid.`,
      remediation:
        'Use lowercase letters, digits, dots, hyphens, or underscores; start with a letter or digit. Scoped names (`@scope/name`) are not supported by `dot new`.',
      metadata: { received: name, pattern: APP_NAME_PATTERN.source },
    });
  }
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
export async function planOperations(opts: RunNewOptions): Promise<{
  operations: FileOperation[];
  target: string;
}> {
  validateAppName(opts.name);

  const template = resolveTemplateName(opts.template);
  const target = resolveTargetDir(opts);
  const templateRoot = opts.templateRoot ?? defaultTemplateRoot(template);
  const pm = opts.pm ?? DEFAULT_PM;

  const templateFiles = await collectTemplateFiles(templateRoot);
  if (templateFiles.length === 0) {
    throw new DotCliError({
      code: DotCliErrorCode.AppLifecycleFailed,
      message: `No template files found under ${templateRoot}.`,
      remediation:
        'The @arki/dot package must ship its `templates/` directory. Reinstall the package or pass --template-root via the programmatic API.',
      metadata: { templateRoot },
    });
  }

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

/** Build the JSON envelope from a plan + status. */
function buildEnvelope(args: {
  name: string;
  target: string;
  operations: FileOperation[];
  errors: DiagnosticIssue[];
  status: DotNewEnvelope['status'];
  generatedAt: string;
}): DotNewEnvelope {
  return {
    status: args.status,
    command: 'new',
    generatedAt: args.generatedAt,
    app: { name: args.name, target: args.target },
    operations: args.operations.map(op => toPublicOperation(op)),
    errors: args.errors,
  };
}

function nowIso(opts: RunNewOptions): string {
  const factory = opts.now ?? (() => new Date());
  return factory().toISOString();
}

/**
 * Run the `new` command. Returns the envelope so callers (CLI + tests)
 * can act on it. Side effects: writes files when not in dry-run mode,
 * emits progress to `out`/`err`.
 */
export async function runNew(opts: RunNewOptions): Promise<DotNewEnvelope> {
  const out = opts.out ?? ((line: string) => process.stdout.write(line));
  const err = opts.err ?? ((line: string) => process.stderr.write(line));
  const generatedAt = nowIso(opts);

  // Plan first — any error here surfaces as a failure envelope.
  let plan: { operations: FileOperation[]; target: string };
  try {
    plan = await planOperations(opts);
  } catch (error) {
    if (error instanceof DotCliError) {
      const envelope = buildEnvelope({
        name: opts.name,
        target: resolveTargetDir(opts),
        operations: [],
        errors: [toIssue(error)],
        status: 'failure',
        generatedAt,
      });
      if (opts.json) out(`${JSON.stringify(envelope, null, 2)}\n`);
      else err(`dot: ${error.code} ${error.message}\n  remediation: ${error.remediation}\n  docs: ${error.docsUrl}\n`);
      return envelope;
    }
    throw error;
  }

  const { operations, target } = plan;

  // Refuse to overwrite a non-empty target dir unless --force.
  if (!opts.dryRun && !opts.force) {
    const hasSkip = operations.some(op => op.action === 'skip');
    const nonEmpty = await directoryIsNonEmpty(target);
    if (hasSkip || nonEmpty) {
      const issue: DiagnosticIssue = {
        code: DotCliErrorCode.InvalidArgs,
        severity: 'error',
        message: `Target directory "${target}" is not empty.`,
        remediation: 'Choose an empty directory, or re-run with --force to overwrite.',
        docsUrl: 'https://docs.arki.dev/dot/cli#new',
        metadata: { target, conflicting: operations.filter(op => op.action === 'skip').map(op => op.path) },
      };
      const envelope = buildEnvelope({
        name: opts.name,
        target,
        operations,
        errors: [issue],
        status: 'failure',
        generatedAt,
      });
      if (opts.json) out(`${JSON.stringify(envelope, null, 2)}\n`);
      else err(`dot: ${issue.code} ${issue.message}\n  remediation: ${issue.remediation}\n`);
      return envelope;
    }
  }

  // Dry-run: emit envelope, write nothing.
  if (opts.dryRun) {
    const envelope = buildEnvelope({
      name: opts.name,
      target,
      operations,
      errors: [],
      status: 'success',
      generatedAt,
    });
    if (opts.json) {
      out(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      out(`Would scaffold ${operations.length} file(s) under ${target}:\n`);
      for (const op of operations) {
        out(`  ${op.action.padEnd(9)} ${op.path}\n`);
      }
    }
    return envelope;
  }

  // Real run: commit files.
  const errors: DiagnosticIssue[] = [];
  const written: FileOperation[] = [];
  for (const op of operations) {
    const dest = path.join(target, op.path);
    try {
      await writeFileEnsuringDir(dest, op.content);
      // Normalise the action to `create` for the envelope; the file was
      // either created or overwritten with the planned content.
      written.push({ ...op, action: op.action === 'skip' ? 'create' : op.action });
    } catch (error) {
      debugNew.debug('write failed for {dest}', { dest, error: error instanceof Error ? error : String(error) });
      errors.push({
        code: DotCliErrorCode.AppLifecycleFailed,
        severity: 'error',
        message: `Failed to write ${op.path}: ${error instanceof Error ? error.message : String(error)}`,
        remediation: 'Check filesystem permissions on the target directory.',
        docsUrl: 'https://docs.arki.dev/dot/cli#new',
        metadata: { target, file: op.path },
      });
    }
  }

  const status: DotNewEnvelope['status'] = errors.length === 0 ? 'success' : 'failure';
  const envelope = buildEnvelope({
    name: opts.name,
    target,
    operations: written,
    errors,
    status,
    generatedAt,
  });

  if (opts.json) {
    out(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (status === 'success') {
    const relativeTarget = path.relative(opts.cwd ?? process.cwd(), target) || '.';
    const pm = opts.pm ?? DEFAULT_PM;
    out(`Scaffolded ${written.length} file(s) under ${relativeTarget}.\n`);
    out(`Next steps:\n`);
    out(`  cd ${relativeTarget}\n`);
    out(`  ${pm} install\n`);
    if (resolveTemplateName(opts.template) === 'stack') {
      out(`  cp .env.example .env\n`);
      out(`  docker compose up -d\n`);
      out(`  ${pm} run dev\n`);
    } else {
      out(`  ${pm} run test\n`);
    }
  } else {
    err(`dot: scaffold completed with ${errors.length} error(s).\n`);
    for (const issue of errors) {
      err(`  ${issue.code} ${issue.message}\n`);
    }
  }
  return envelope;
}

function toIssue(error: DotCliError): DiagnosticIssue {
  return {
    code: error.code,
    severity: 'error',
    message: error.message,
    remediation: error.remediation,
    docsUrl: error.docsUrl,
    metadata: error.metadata,
  };
}
