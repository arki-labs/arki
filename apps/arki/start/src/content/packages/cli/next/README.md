# @arki/cli

Typed command-line programs from one `defineCommand({...})`. The input schema drives the flags, their coercion and their help. A run writes a JSON envelope when stdout is a pipe and text on a terminal. Exit codes are stable. Help and `--version` never run a command, and import at most one lazy level of the tree.

It runs on Node, Bun and Deno. It is not a prompt or color library, and it does not configure logging: the bin file does that.

```text
 argv ─▶ parse flags (from the input schema) ─▶ validate ─▶ run(input)
                                                              │
        terminal: text  ◀── render ◀── data or failure ───────┤
        pipe:     JSON envelope (arki.cli/1) + exit code ◀────┘
```

## Install

```sh
bun add @arki/cli
```

Bring any Standard Schema validator that can produce JSON Schema (Zod 4, Valibot with its JSON Schema bridge, ArkType). The examples use Zod.

## Quick start

One command, one program, one run. `main` takes the argument list and the
output functions, so the whole run happens in-process and returns the exit
code:

```ts run
import { z } from 'zod';

import { defineCli, defineCommand, group } from '@arki/cli';

const greet = defineCommand({
  describe: 'Greet someone',
  input: z.object({ name: z.string().default('world').describe('Who to greet') }),
  run: ({ input }) => ({ greeting: `Hello, ${input.name}` }),
});

const program = defineCli({
  name: 'app',
  version: '1.0.0',
  commands: { greet, admin: group('Administration', { greet }) },
});

let stdout = '';
const exitCode = await program.main(['greet', '--name', 'Ada'], {
  stdout: text => {
    stdout += text;
  },
  tty: false,
});
const envelope: unknown = JSON.parse(stdout);
if (exitCode !== 0 || !JSON.stringify(envelope).includes('Hello, Ada')) throw new Error(stdout);
```

`main(argv, io)` never exits the process. `run(program)` is the only process
boundary (see [Programs](#programs)).

## When not to use this

- **You need prompts, colors or spinners.** This package parses, validates,
  runs and prints. Pair it with a prompt library for interactive input.
- **You are building a full-screen terminal UI.** Use a TUI library; a
  command here returns data, it does not own the screen.
- **The script takes one flag.** `parseArgs` from `node:util` is shorter.
- **Your validator cannot produce JSON Schema.** Flags, coercion and help come
  from the input schema's JSON Schema. Zod 4, Valibot with its JSON Schema
  bridge and ArkType can produce it.

## Runtime support

It runs on Node, Bun and Deno. `main(argv, io)` writes only to the `io`
functions you pass and never exits the process. `run(program)` reads
`process.argv`, wires stdout, stderr, the terminal and `SIGINT`/`SIGTERM`,
and exits with the code. `bun run test:runtimes` checks the built `dist/` on
each runtime.

## Public imports

One entry, `@arki/cli`:

| Export                                                                                                       | What it is                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `defineCommand`                                                                                              | One command: input schema, `run`, optional `preview` and `render`. |
| `group`                                                                                                      | A named branch of commands.                                        |
| `defineCli`                                                                                                  | The program: name, version and the command tree.                   |
| `run`                                                                                                        | The process boundary: argv in, exit code out.                      |
| `ExitCode`                                                                                                   | The stable exit codes, by name.                                    |
| `UnknownCommand`, `InvalidInput`, `PreviewUnsupported`, `InputRequired`, `ConfirmationRequired`, `Cancelled` | The framework failures (`cli.*`).                                  |
| types `Command`, `RunContext`, `InputOf`, `OutputOf`, `Program`, `Io`, `Ui`, `Envelope`, …                   | Inferred from your definitions; write no type arguments.           |

## Commands

One file per command. `input` is an object schema; each key becomes a `--kebab-case` flag. `run` gets the validated input (defaults filled, transforms applied) and returns the data, or a failure from `@arki/failure`.

```ts
import { z } from 'zod';

import { defineCommand } from '@arki/cli';

export default defineCommand({
  describe: 'Seed the embeddings',
  input: z.object({
    maxBatches: z.int().min(1).optional().describe('Stop after this many batches'),
    yes: z.boolean().default(false).describe('Skip the confirmation'),
  }),
  args: ['maxBatches'],
  run: ({ input }) => ({ embedded: (input.maxBatches ?? 1) * 100 }),
});
```

`args` names the keys taken as positionals, in order. Booleans take `--yes` and `--no-yes`. Numbers are coerced, and `2junk` fails. An array key takes a repeated flag or a comma list. Unknown flags fail, and so does a scalar given twice.

## Programs

Register each command in the tree with one line. A lazy entry (`() => import(...)`) is loaded only when its branch is taken.

At the process boundary, `run(program)` reads `process.argv`, wires stdout, stderr, the terminal and SIGINT/SIGTERM, and exits with the code:

```ts skip="a bin entry: it calls process.exit"
import { defineCli, run } from '@arki/cli';

await run(
  defineCli({
    name: 'app',
    version: '1.0.0',
    commands: { seed: () => import('./commands/seed.js') },
  }),
);
```

## Output

| Where stdout goes     | Default mode | Override                                |
| --------------------- | ------------ | --------------------------------------- |
| A terminal            | `text`       | `-o json`, `--json`, `ARKI_OUTPUT=json` |
| A pipe, file or agent | `json`       | `-o text`, `ARKI_OUTPUT=text`           |

`-o ndjson` writes one line per element of `data.items`, then the envelope without `data`. `--fields a,b.c` keeps only those paths of `data`, in every mode.

The envelope (`arki.cli/1`) always has every key:

```json
{
  "ok": false,
  "command": ["seed"],
  "data": null,
  "error": {
    "code": "cli.invalid_input",
    "message": "--max-batches expected an integer, received \"big\"",
    "remediation": "Fix the flags named in the issues; run with --help to see them.",
    "issues": [
      {
        "path": ["maxBatches"],
        "flag": "--max-batches",
        "message": "--max-batches expected an integer, received \"big\""
      }
    ],
    "data": null,
    "retryable": false,
    "outcome": "unchanged",
    "exitCode": 2,
    "docsUrl": null
  },
  "meta": { "schema": "arki.cli/1", "version": "1.0.0", "durationMs": 0, "dryRun": false }
}
```

In text mode a command can draw its own output with `render(data, ui)`. Without it, an object prints as `key: value` lines and an array of objects as a table. A failure goes to stderr.

## Exit codes

| Code | `ExitCode`      | When                                                                  |
| ---- | --------------- | --------------------------------------------------------------------- |
| 0    | `ok`            | `run` succeeded; help; `--version`                                    |
| 1    | `bug`           | something threw: `cli.bug`, message only, the stack goes to the log   |
| 2    | `usage`         | `cli.unknown_command`, `cli.invalid_input`, `cli.preview_unsupported` |
| 3    | `failure`       | `run` returned a failure                                              |
| 4    | `retry`         | `run` returned a failure with status 429 or 503                       |
| 5    | `inputRequired` | `cli.input_required`, `cli.confirmation_required`                     |
| 130  | `interrupted`   | `cli.cancelled`: the run ended after SIGINT/SIGTERM                   |

## Global flags

Every command takes `-o, --output <auto|text|json|ndjson>`, `--json`, `--fields`, `--input-json <object>`, `--input-file <path|->`, `-q, --quiet`, `--no-color`, `--dry-run`, `-h, --help` and `--version`. An input key may not use one of these names; `defineCli` throws and names the key.

`--input-json` and `--input-file` replace the flags: the whole input as one JSON object. Mixing them with flags is invalid input. `--dry-run` runs the command's `preview` instead of `run` and sets `meta.dryRun`; a command without `preview` fails with exit 2.

## Failure behaviour

A command never throws on purpose. `run` returns data or a failure value, and
the program turns it into the envelope and an exit code. Anything that does
throw is a bug: exit `1`, code `cli.bug`, the message only, and the stack goes
to the log.

`run` returns failures as values, with `@arki/failure`:

```ts
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { defineFailure } from '@arki/failure';

const ProviderDown = defineFailure('embed.provider_down', {
  status: 503,
  message: 'provider {provider} is not answering',
  remediation: 'Start the provider, then run again.',
  data: z.object({ provider: z.string() }),
});

export default defineCommand({
  describe: 'Embed one text',
  input: z.object({ text: z.string() }),
  run: async ({ input }) => {
    const answered = await Promise.resolve(input.text.length > 0);
    return answered ? { vectors: 1 } : ProviderDown({ provider: 'local' });
  },
});
```

The output type is what `run` succeeds with: the failure is removed from it. Status 429 or 503 makes the failure retryable (exit 4); any other returned failure exits 3.

The framework's own failures:

| Code                        | Exit | When                                                     | Fix                                         |
| --------------------------- | ---- | -------------------------------------------------------- | ------------------------------------------- |
| `cli.unknown_command`       | 2    | The command name is not one at this level.               | Pick a name from `.error.data.suggestions`. |
| `cli.invalid_input`         | 2    | The command line does not fit the input schema.          | Fix the flags named in `.error.issues`.     |
| `cli.preview_unsupported`   | 2    | `--dry-run` on a command without `preview`.              | Run it without `--dry-run`.                 |
| `cli.input_required`        | 5    | A required value is missing and there is no terminal.    | Pass the flag in `.error.data.flag`.        |
| `cli.confirmation_required` | 5    | The command needs confirmation and there is no terminal. | Pass `--yes`.                               |
| `cli.cancelled`             | 130  | `SIGINT` or `SIGTERM` ended the run.                     | Check what it changed, then run it again.   |

## Limits

- **Strict parsing.** Unknown flags fail, and so does a scalar flag given
  twice. Numbers are coerced strictly: `--max-batches 2junk` is
  `cli.invalid_input` with exit `2`, not the number `2`.
- **Reserved names.** An input key may not use a global flag name (`output`,
  `json`, `fields`, `quiet`, `dryRun`, `help`, `version`, …). `defineCli`
  throws and names the key.
- **Flags or JSON, not both.** `--input-json` and `--input-file` replace the
  flags. Mixing them with flags is `cli.invalid_input`.
- **Schema defaults apply in validation.** The parser never fills them. A
  schema without a default leaves the key `undefined`.
- **No terminal, no questions.** Without a terminal, a missing value or a
  confirmation fails with exit `5` instead of waiting for input.

## Documentation

- [Agent guide](./docs/agent-guide.md): add a command, group commands, return
  a failure, offer a dry run, test a command.
- [`llms.txt`](./llms.txt): the map for agents.
- [`AGENTS.md`](./AGENTS.md): the laws for changing this package.
- [CHANGELOG.md](./CHANGELOG.md): what changed in each version.

## Support

Report bugs and ask questions at
[github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).
Include the command line, the JSON envelope (`--json`) and the exit code.

## License

MIT — see [LICENSE](./LICENSE).
