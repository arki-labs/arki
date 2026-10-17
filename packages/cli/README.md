# @arki/cli

Typed command-line programs from one `defineCommand({...})`. The input schema drives the flags, their coercion and their help. A run writes a JSON envelope when stdout is a pipe and text on a terminal. Exit codes are stable. Help and `--version` never run a command, and import at most one lazy level of the tree.

It runs on Node, Bun and Deno. It is not a prompt or color library, and it does not configure logging: the bin file does that.

## Install

```sh
bun add @arki/cli
```

Bring any Standard Schema validator that can produce JSON Schema (Zod 4, Valibot with its JSON Schema bridge, ArkType). The examples use Zod.

## A command

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

## A program

Register each command in the tree with one line. A lazy entry (`() => import(...)`) is loaded only when its branch is taken.

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

## Failures

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

## License

MIT
