/**
 * `dot new <app>` — scaffold a minimal DOT app.
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
 * Templates live at `packages/dot/templates/app-minimal/` and use
 * `.tmpl` suffixes + `{{name}}`-style placeholders. The suffix is
 * stripped during scaffolding so `package.json.tmpl` becomes
 * `package.json` on disk.
 *
 * Commands deferred to v1.1 (`dot add <plugin>`, `dot dev`,
 * `dot migrate`) are deliberately NOT surfaced here.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createDebugLogger } from '@arki/log/debug';

import type { DiagnosticIssue } from '../diagnostics.js';
import type { FileOperation } from './files.js';
import type { DotNewEnvelope } from './json.js';
import {
  collectTemplateFiles,
  directoryIsNonEmpty,
  fileExists,
  readTemplate,
  sha256,
  utf8ByteLength,
  writeFileEnsuringDir,
} from './files.js';
import { DotCliError, DotCliErrorCode } from './error-codes.js';
import { toPublicOperation } from './json.js';

const debugNew = createDebugLogger('arki:dot:cli:new');

/**
 * Package manager the generated README + AGENTS.md will reference.
 * `bun` is the default because the kernel + adapter packages are tested
 * with Bun first.
 */
export type PackageManager = 'npm' | 'pnpm' | 'bun';

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
   * leave this undefined so the bundled `templates/app-minimal/`
   * directory is used.
   */
  readonly templateRoot?: string;
  /**
   * Version values inlined into the generated `package.json`. The
   * defaults track the current `@arki/dot` + `@arki/env` releases.
   */
  readonly versions?: {
    readonly dot?: string;
    readonly env?: string;
    readonly zod?: string;
  };
};

/** Defaults for inlined dependency versions. Kept in one place. */
const DEFAULT_VERSIONS = {
  dot: '0.1.0',
  env: '0.1.0',
  zod: '4.3.5',
} as const;

const DEFAULT_PM: PackageManager = 'bun';

const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const FILE_REASONS: Record<string, string> = {
  'package.json': 'Package manifest with @arki/dot + @arki/env dependencies',
  'tsconfig.json': 'TypeScript config for ESM + NodeNext + strict mode',
  'README.md': 'Quickstart and inspection commands',
  'AGENTS.md':
    'Agent-readable conventions (verification commands, public/private boundaries, DOT artifact locations)',
  '.gitignore': 'Standard ignores for node_modules, dist, env files',
  'src/app.ts': 'App entrypoint composing defineApp + env adapter',
  'src/env.ts': 'Env schema (zod) consumed by @arki/env/dot',
  'tests/boot.test.ts': 'Vitest that boots the app and asserts manifest shape',
};

const TEMPLATE_SUFFIX = '.tmpl';

/**
 * Resolve the default template directory, anchored relative to this
 * source file. Works both when running from `src/` under Bun and from
 * `dist/` after `tsc` — both layouts put the templates directory two
 * levels above (`packages/dot/templates/app-minimal`).
 */
function defaultTemplateRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'templates', 'app-minimal');
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

function describeFile(relativePath: string): string {
  return FILE_REASONS[relativePath] ?? `Scaffold file: ${relativePath}`;
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

  const target = resolveTargetDir(opts);
  const templateRoot = opts.templateRoot ?? defaultTemplateRoot();
  const pm = opts.pm ?? DEFAULT_PM;
  const versions = {
    dot: opts.versions?.dot ?? DEFAULT_VERSIONS.dot,
    env: opts.versions?.env ?? DEFAULT_VERSIONS.env,
    zod: opts.versions?.zod ?? DEFAULT_VERSIONS.zod,
  };

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
    dotVersion: versions.dot,
    envVersion: versions.env,
    zodVersion: versions.zod,
  };

  const operations: FileOperation[] = [];
  for (const templateRelPath of templateFiles) {
    const absoluteTemplate = path.join(templateRoot, templateRelPath);
    const raw = await readTemplate(absoluteTemplate);
    const rendered = substitute(raw, vars);

    const stripped = templateRelPath.endsWith(TEMPLATE_SUFFIX)
      ? templateRelPath.slice(0, -TEMPLATE_SUFFIX.length)
      : templateRelPath;
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
      reason: describeFile(stripped),
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
      debugNew('write failed for %s: %O', dest, error);
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
    out(`Scaffolded ${written.length} file(s) under ${path.relative(opts.cwd ?? process.cwd(), target) || '.'}.\n`);
    out(`Next steps:\n`);
    out(`  cd ${path.relative(opts.cwd ?? process.cwd(), target) || '.'}\n`);
    out(`  ${opts.pm ?? DEFAULT_PM} install\n`);
    out(`  ${opts.pm ?? DEFAULT_PM} run test\n`);
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
