/**
 * `defineCli`: a command tree, a name and a version become a `Program` whose
 * `main(argv, io)` resolves the path, answers help and `--version` without
 * running anything, parses and validates the input, runs the command and
 * writes the envelope. `main` never touches the process; `run` does.
 */
import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { isFailure, InvalidInput as SchemaInvalidInput } from '@arki/failure';
import { getLogger } from '@arki/log';
import { parseAsync, pathOf } from '@arki/schema';

import type { AnyCommand, AnyRunContext, Mode } from './command.js';
import type { Envelope, EnvelopeContext } from './envelope.js';
import type { InputIssue } from './failures.js';
import type { FlagSpec } from './flags.js';
import type { ParseIssue } from './parse.js';
import type { CommandTree, Group } from './tree.js';
import { bugEnvelope, exitCodeOfEnvelope, failureEnvelope, okEnvelope } from './envelope.js';
import { Cancelled, ExitCode, InvalidInput, PreviewUnsupported } from './failures.js';
import { flagsOf, GLOBAL_FLAGS, isGlobal } from './flags.js';
import { commandHelp, groupHelp } from './help.js';
import { readInputText } from './input.js';
import { isOutputChoice, parseFields, pickFields, resolveMode, writeEnvelope } from './output.js';
import { parse } from './parse.js';
import { group, isGroup, resolvePath } from './tree.js';
import { createUi } from './ui.js';

/** What `main` reads and writes instead of the process. Tests pass their own. */
export type Io = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Read only for `--input-file -`. */
  readonly stdin: AsyncIterable<Uint8Array | string> | null;
  /** Whether stdout is a terminal: decides `auto` output. */
  readonly tty: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborted on SIGINT/SIGTERM by `run`. */
  readonly signal: AbortSignal;
};

/**
 * A CLI definition. Standalone commands written in their own files have no
 * services (`ctx.services` is `{}`); a command written inline in `commands`
 * sees `ctx.services` as `unknown`. Typed services come from a feature-bound
 * tree (Dot), not from here.
 */
export type Cli = {
  /** The program name, as typed: shown in usage lines. */
  readonly name: string;
  readonly version: string;
  /** One line under the program name in root help. */
  readonly describe?: string;
  readonly commands: CommandTree;
  /**
   * What every command's `ctx.services` is. Resolved once, after parsing and
   * before `run`; never for help, `--version` or a parse failure. Without it,
   * commands get an empty object.
   */
  readonly services?: () => unknown;
  /** Base URL of the error docs: an envelope's `error.docsUrl` is `<docsUrl>#<code with . and _ as ->`. */
  readonly docsUrl?: string;
};

export type Program = Cli & {
  /** Run one command line. Returns the exit code; never calls `process.exit`. A missing `io` field writes nowhere. */
  readonly main: (argv: readonly string[], io?: Partial<Io>) => Promise<number>;
};

function ignore(): void {
  // A missing writer drops the text.
}

const NEVER_ABORTED = new AbortController().signal;

function withDefaults(io: Partial<Io>): Io {
  return {
    stdout: io.stdout ?? ignore,
    stderr: io.stderr ?? ignore,
    stdin: io.stdin ?? null,
    tty: io.tty ?? false,
    env: io.env ?? {},
    signal: io.signal ?? NEVER_ABORTED,
  };
}

/** Names and eager aliases must be unique per level; eager input keys must not collide with global flags. */
function checkTree(tree: CommandTree, where: readonly string[]): void {
  const names = new Set(Object.keys(tree));
  for (const [name, entry] of Object.entries(tree)) {
    if (typeof entry === 'function') continue;
    if (isGroup(entry)) {
      checkTree(entry.commands, [...where, name]);
      continue;
    }
    for (const alias of entry.aliases ?? []) {
      if (names.has(alias)) {
        throw new TypeError(`defineCli: "${[...where, alias].join(' ')}" is already a command or alias at this level.`);
      }
      names.add(alias);
    }
    if (entry.input !== undefined) flagsOf(entry.input, entry.args);
  }
}

/** Mode and quiet read straight from argv, for failures before the command line is parsed. */
function earlyMode(argv: readonly string[], io: Io): Mode {
  let output: string | undefined;
  for (const [index, arg] of argv.entries()) {
    if (arg === '--json') return 'json';
    if (arg === '-o' || arg === '--output') output = argv[index + 1];
    else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
  }
  return resolveMode({
    json: false,
    output: output !== undefined && isOutputChoice(output) ? output : undefined,
    env: io.env,
    tty: io.tty,
  });
}

function issueFromParse(issue: ParseIssue): InputIssue {
  return { path: issue.key === undefined ? [] : [issue.key], flag: issue.flag, message: issue.message };
}

function flagOf(specs: readonly FlagSpec[], key: string | undefined): string | undefined {
  const spec = specs.find(entry => entry.key === key);
  if (spec === undefined) return undefined;
  return spec.position === undefined ? `--${spec.flag}` : `<${spec.flag}>`;
}

function issuesFromSchema(issues: readonly StandardSchemaV1.Issue[], specs: readonly FlagSpec[]): InputIssue[] {
  return issues.map(issue => {
    const path = pathOf(issue).map(String);
    const flag = flagOf(specs, path[0]);
    return { path, flag, message: flag === undefined ? issue.message : `${flag}: ${issue.message}` };
  });
}

function invalid(...issues: InputIssue[]): Failure {
  return InvalidInput({ issues });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The raw input: from `--input-json`/`--input-file`, or the flags. Mixing the two is invalid. */
async function rawInput(
  flags: Readonly<Record<string, unknown>>,
  globals: Readonly<Record<string, unknown>>,
  io: Io,
): Promise<{ readonly value: unknown } | Failure> {
  const inline = stringValue(globals['inputJson']);
  const file = stringValue(globals['inputFile']);
  if (inline === undefined && file === undefined) return { value: flags };
  const flag = inline === undefined ? '--input-file' : '--input-json';
  if (inline !== undefined && file !== undefined) {
    return invalid({ path: [], flag, message: '--input-json and --input-file cannot be used together' });
  }
  if (Object.keys(flags).length > 0) {
    return invalid({ path: [], flag, message: `${flag} replaces the flags; pass the whole input in it` });
  }
  let text: string;
  try {
    text = inline ?? (await readInputText(file ?? '-', io.stdin));
  } catch (error) {
    return invalid({ path: [], flag, message: `${flag}: ${error instanceof Error ? error.message : String(error)}` });
  }
  try {
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return invalid({ path: [], flag, message: `${flag}: not valid JSON` });
  }
}

/** The command's input, validated by its own schema; schema defaults apply here. */
async function validated(
  command: AnyCommand,
  raw: unknown,
  specs: readonly FlagSpec[],
): Promise<{ readonly value: unknown } | Failure> {
  if (command.input === undefined) return { value: {} };
  const result = await parseAsync(command.input, raw);
  if (SchemaInvalidInput.is(result)) return invalid(...issuesFromSchema(result.data.issues, specs));
  if (isFailure(result)) return result;
  return { value: result };
}

/**
 * Define a CLI. Checks the definition once (duplicate names or aliases at a
 * level, input keys that collide with global flags) and returns a `Program`.
 *
 * @example
 * const program = defineCli({ name: 'app', version: '1.0.0', commands: { hello } });
 * const exitCode = await program.main(['hello', '--name', 'Ada'], { stdout: text => out.push(text) });
 */
export function defineCli(def: Cli): Program {
  checkTree(def.commands, []);
  const root: Group = group(def.describe ?? '', def.commands);

  async function execute(argv: readonly string[], io: Io): Promise<number> {
    const terminator = argv.indexOf('--');
    const head = terminator === -1 ? argv : argv.slice(0, terminator);
    if (head.includes('--version')) {
      io.stdout(`${def.version}\n`);
      return ExitCode.ok;
    }
    let mode = earlyMode(head, io);
    let quiet = head.includes('-q') || head.includes('--quiet');
    let path: readonly string[] = [];
    let dryRun = false;
    let started: number | undefined;
    let render: ((data: unknown, ui: ReturnType<typeof createUi>) => void) | undefined;

    const finish = (envelopeOf: (context: EnvelopeContext) => Envelope<unknown>): number => {
      const context: EnvelopeContext = {
        command: path,
        version: def.version,
        durationMs: started === undefined ? 0 : Math.round(performance.now() - started),
        dryRun,
        docsUrl: def.docsUrl,
      };
      const envelope = envelopeOf(context);
      const ui = createUi({ mode, quiet, stdout: io.stdout, stderr: io.stderr });
      writeEnvelope(envelope, { mode, name: def.name, ui, render, stdout: io.stdout, stderr: io.stderr });
      return exitCodeOfEnvelope(envelope);
    };
    const fail = (failure: Failure): number => finish(context => failureEnvelope(failure, context));

    try {
      const resolved = await resolvePath(root, argv);
      if (isFailure(resolved)) return fail(resolved);
      const { node, rest } = resolved;
      path = resolved.path;
      const wantsHelp = head.includes('--help') || head.includes('-h');
      if (isGroup(node)) {
        const text = await groupHelp(def.name, path, node);
        if (wantsHelp || rest.length === 0) {
          io.stdout(text);
          return ExitCode.ok;
        }
        io.stderr(text);
        return ExitCode.usage;
      }
      const specs = node.input === undefined ? [] : flagsOf(node.input, node.args);
      if (wantsHelp) {
        io.stdout(commandHelp(def.name, path, node, specs));
        return ExitCode.ok;
      }

      const parsed = parse([...GLOBAL_FLAGS, ...specs], rest);
      if (!parsed.ok) return fail(invalid(...parsed.issues.map(issue => issueFromParse(issue))));
      const globals: Record<string, unknown> = {};
      const flags: Record<string, unknown> = {};
      for (const spec of [...GLOBAL_FLAGS, ...specs]) {
        if (!(spec.key in parsed.value)) continue;
        (isGlobal(spec) ? globals : flags)[spec.key] = parsed.value[spec.key];
      }
      const output = stringValue(globals['output']);
      if (output !== undefined && !isOutputChoice(output)) {
        return fail(
          invalid({
            path: [],
            flag: '--output',
            message: `--output must be auto, text, json or ndjson, received "${output}"`,
          }),
        );
      }
      mode = resolveMode({ json: globals['json'] === true, output, env: io.env, tty: io.tty });
      quiet = globals['quiet'] === true;
      dryRun = globals['dryRun'] === true;
      render = node.render === undefined ? undefined : (data, ui) => node.render?.(data, ui);

      const raw = await rawInput(flags, globals, io);
      if (isFailure(raw)) return fail(raw);
      const input = await validated(node, raw.value, specs);
      if (isFailure(input)) return fail(input);
      if (dryRun && node.preview === undefined) return fail(PreviewUnsupported({ command: [...path] }));

      started = performance.now();
      const services: unknown = def.services === undefined ? {} : await def.services();
      // A function, not the property: the checks below run after awaits, when the signal may have changed.
      const aborted = (): boolean => io.signal.aborted;
      if (aborted()) return fail(Cancelled());
      const ctx: AnyRunContext<unknown> = {
        input: input.value,
        services,
        ui: createUi({ mode, quiet, stdout: io.stdout, stderr: io.stderr }),
        mode,
        signal: io.signal,
        log: getLogger(['arki', 'cli', ...path].join(':')),
      };
      let result: unknown;
      try {
        result = dryRun && node.preview !== undefined ? await node.preview(ctx) : await node.run(ctx);
      } catch (error) {
        if (aborted()) return fail(Cancelled());
        throw error;
      }
      if (aborted()) return fail(Cancelled());
      if (isFailure(result)) return fail(result);
      const fields = stringValue(globals['fields']);
      const data = fields === undefined ? result : pickFields(result, parseFields(fields));
      return finish(context => okEnvelope(data, context));
    } catch (error) {
      const log = getLogger(['arki', 'cli', ...path].join(':'));
      if (error instanceof Error) log.error(error, { command: path.join(' ') });
      else log.error('command threw a non-error value {value}', { value: String(error) });
      return finish(context => bugEnvelope(error, context));
    }
  }

  return {
    ...def,
    main: (argv, io = {}) => execute(argv, withDefaults(io)),
  };
}
