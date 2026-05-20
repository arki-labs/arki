#!/usr/bin/env bun
/**
 * `arki-release` CLI entrypoint.
 *
 * Parses `Bun.argv`, dispatches to a subcommand handler, and emits the
 * shared {@link ReleaseCommandEnvelope}. In this task (Task 1) every
 * subcommand is an honest stub that returns `status: 'pending'` — the real
 * logic lands in Tasks 2-7.
 */
import debugFactory from 'debug';

import { defaultConfigPath, loadConfig, ReleaseConfigError } from './config';
import { runInventory } from './inventory';
import { createEnvelope, emitEnvelope } from './json-output';
import type { ParsedCliArgs, ReleaseCommand, ReleaseCommandEnvelope } from './types';

const debug = debugFactory('arki:release:cli');

/**
 * Known subcommands and their implementation task references.
 *
 * Stable order — used by the help text and the no-args dispatch path.
 */
const SUBCOMMANDS: ReadonlyArray<{
  readonly name: ReleaseCommand;
  readonly task: string;
  readonly description: string;
}> = [
  {
    name: 'inventory',
    task: 'Task 2',
    description: 'Discover workspace packages and classify release waves.',
  },
  {
    name: 'audit',
    task: 'Task 4',
    description: 'Leak-scan publishable packages and run npm pack audits.',
  },
  {
    name: 'export-public',
    task: 'Task 5',
    description: 'Materialize the .release/arki-public/ tree for publication.',
  },
  {
    name: 'pack',
    task: 'Task 3',
    description: 'Resolve workspace:* / catalog: into concrete npm versions.',
  },
  {
    name: 'fixture',
    task: 'Task 6',
    description: 'Drive external npm/pnpm/Bun install fixtures.',
  },
  {
    name: 'scorecard',
    task: 'Task 7',
    description: 'Emit the release scorecard gating publication.',
  },
];

const KNOWN_COMMANDS: ReadonlySet<ReleaseCommand> = new Set(SUBCOMMANDS.map(sub => sub.name));

/**
 * Parse the raw `Bun.argv` (or any string[] equivalent) into a structured
 * {@link ParsedCliArgs} shape. Argument parsing is intentionally minimal —
 * we lean on Bun's native argv and avoid a third-party parser.
 *
 * Accepted forms:
 *   arki-release                 → help
 *   arki-release help            → help
 *   arki-release --help          → help
 *   arki-release <cmd>           → run <cmd> in text mode
 *   arki-release <cmd> --json    → run <cmd> in JSON mode
 *
 * Unknown commands resolve to `command: null` with `help: true` so the
 * dispatcher can show usage and exit gracefully.
 */
export function parseArgs(argv: readonly string[]): ParsedCliArgs {
  const rest: string[] = [];
  let json = false;
  let help = false;
  let command: ReleaseCommand | null = null;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      help = true;
      continue;
    }
    if (command === null && !arg.startsWith('-')) {
      if (isReleaseCommand(arg)) {
        command = arg;
      } else {
        help = true;
        rest.push(arg);
      }
      continue;
    }
    rest.push(arg);
  }

  if (command === null && !help) {
    help = true;
  }

  return { command, json, help, rest };
}

function isReleaseCommand(value: string): value is ReleaseCommand {
  return (KNOWN_COMMANDS as ReadonlySet<string>).has(value);
}

/**
 * Build the help envelope. Returned as an envelope (not raw text) so the
 * `--json` channel exposes the same command catalogue agents see in text.
 */
function buildHelpEnvelope(): ReleaseCommandEnvelope<
  { name: ReleaseCommand; task: string; description: string },
  { message: string; commands: number }
> {
  return createEnvelope({
    command: 'help',
    status: 'pending',
    summary: {
      message: 'arki-release CLI scaffold — subcommand implementations land in Tasks 2-7.',
      commands: SUBCOMMANDS.length,
    },
    items: SUBCOMMANDS.map(sub => ({ ...sub })),
  });
}

/**
 * Build a stub envelope for a real subcommand. Status is `pending` —
 * NOT `success` — because the implementation is intentionally absent in
 * Task 1. Downstream gates that key on `status === 'success'` will
 * correctly treat the stub as not-yet-shippable.
 */
function buildStubEnvelope(command: ReleaseCommand): ReleaseCommandEnvelope<never, { message: string; task: string }> {
  const meta = SUBCOMMANDS.find(sub => sub.name === command);
  const taskRef = meta?.task ?? 'a follow-up task';
  return createEnvelope({
    command,
    status: 'pending',
    summary: {
      message: `${command}: not yet implemented — see ${taskRef}.`,
      task: taskRef,
    },
    items: [],
    errors: [],
  });
}

/**
 * Render the help text manually (in addition to the envelope-driven
 * one-liner from `renderHumanText`) so humans get an actionable usage
 * block.
 */
function renderHelpText(): string {
  const lines: string[] = [];
  lines.push('arki-release — internal release rails for @arki/* packages');
  lines.push('');
  lines.push('Usage: arki-release <command> [--json]');
  lines.push('');
  lines.push('Commands:');
  const width = Math.max(...SUBCOMMANDS.map(sub => sub.name.length));
  for (const sub of SUBCOMMANDS) {
    const padded = sub.name.padEnd(width, ' ');
    lines.push(`  ${padded}  ${sub.description}  (${sub.task})`);
  }
  lines.push('');
  lines.push('Global flags:');
  lines.push('  --json   Emit a ReleaseCommandEnvelope as JSON on stdout.');
  lines.push('  --help   Show this message.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Convert a {@link ReleaseConfigError} into a failure envelope. The CLI
 * uses this so config errors don't bubble up as uncaught exceptions; they
 * land in the same envelope channel agents already know how to parse.
 */
function buildConfigErrorEnvelope(
  command: ReleaseCommand,
  cause: ReleaseConfigError,
): ReleaseCommandEnvelope<never, { message: string; configError: true }> {
  return createEnvelope({
    command,
    status: 'failure',
    summary: { message: `Config load failed: ${cause.message}`, configError: true },
    items: [],
    errors: [
      {
        code: cause.code,
        severity: 'error',
        message: cause.message,
        remediation: 'Fix arki.release.config.ts and retry.',
      },
    ],
  });
}

/**
 * Dispatch parsed args to the right envelope-producing handler and emit
 * the result. Returns the process exit code the caller should use.
 */
export async function dispatch(args: ParsedCliArgs): Promise<number> {
  debug('dispatch %o', args);

  if (args.help || args.command === null) {
    const envelope = buildHelpEnvelope();
    if (args.json) {
      emitEnvelope(envelope, { json: true });
    } else {
      process.stdout.write(renderHelpText());
    }
    return 0;
  }

  if (args.command === 'inventory') {
    return runInventoryHandler(args.json);
  }

  const envelope = buildStubEnvelope(args.command);
  emitEnvelope(envelope, { json: args.json });
  return 0;
}

/**
 * Inventory subcommand handler: load config, run the inventory pass,
 * emit the envelope, and map envelope status → exit code.
 *
 * A `failure` envelope produces exit code 1 so CI gates treat it as a
 * non-recoverable error.
 */
async function runInventoryHandler(json: boolean): Promise<number> {
  const cwd = process.cwd();
  const configPath = defaultConfigPath(cwd);
  try {
    const config = await loadConfig(configPath);
    const envelope = await runInventory({ cwd, config });
    emitEnvelope(envelope, { json });
    return envelope.status === 'failure' ? 1 : 0;
  } catch (cause) {
    if (cause instanceof ReleaseConfigError) {
      const envelope = buildConfigErrorEnvelope('inventory', cause);
      emitEnvelope(envelope, { json });
      return 1;
    }
    throw cause;
  }
}

/**
 * Run the CLI when invoked directly (e.g. `bun src/cli.ts inventory`).
 *
 * Bun executes the file top-to-bottom; we use `import.meta.main` to gate
 * the side-effectful dispatch so the module can also be imported for
 * testing without triggering a stdout write.
 */
if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  dispatch(args)
    .then(code => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      // Last-resort guard — should not happen because handlers convert
      // expected errors into envelopes. Surface to stderr and exit 2.
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`arki-release: unhandled error\n${message}\n`);
      process.exit(2);
    });
}
