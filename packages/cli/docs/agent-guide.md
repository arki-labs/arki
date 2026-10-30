# @arki/cli for agents

Read [llms.txt](../llms.txt) first for the index. When this guide and `llms.txt` disagree, this guide wins; when this guide and the code disagree, the code in `src/` wins.

## The model

1. A command is one `defineCommand({ describe, input?, args?, run, ... })`. `input` is an object Standard Schema with JSON Schema; its keys are the flags.
2. A program is `defineCli({ name, version, commands })`. `commands` is a tree: commands, `group(describe, tree)`, and lazy entries `() => import('./x.js')`.
3. `program.main(argv, io)` returns the exit code and never exits. `run(program)` is the process boundary: argv, stdio, terminal, signals, `process.exit`.
4. Output is a JSON envelope (`arki.cli/1`) when stdout is not a terminal, text when it is. `-o`, `--json` and `ARKI_OUTPUT` override.
5. `run` returns data or an `@arki/failure` value. A returned failure exits 3, or 4 when its status is 429 or 503. A throw is a bug: exit 1.
6. `with: [step, around]` on a command runs plain functions before `run` and `preview`. A step that returns a failure is the command's failure. An around must declare `next` as a plain second parameter. See [Steps and arounds](#steps-and-arounds).
7. Help and `--version` never call `run` or `services`. Help imports one lazy level below the path asked; command help imports that command's module (and its schema library).

## Task map

### Add a command

1. Create `src/commands/<name>.ts` with one default export:

   ```ts
   import { z } from 'zod';

   import { defineCommand } from '@arki/cli';

   export default defineCommand({
     describe: 'List the users',
     input: z.object({ limit: z.int().min(1).default(20).describe('How many to list') }),
     effects: 'read',
     run: ({ input }) => ({ items: [{ id: 'usr_ada', name: 'Ada' }].slice(0, input.limit) }),
   });
   ```

2. Register it in the program file (`src/cli.ts`) with one line: `users: () => import('./commands/users.js'),`.
3. Check it: `app users --help`, then `app users --json`.

### Group commands

1. Wrap the entries in `group(describe, tree)`. In an app the entries are lazy lines such as `list: () => import('./commands/users/list.js')`; a group may itself be lazy.

   ```ts
   import { defineCli, defineCommand, group } from '@arki/cli';

   const list = defineCommand({ describe: 'List the users', aliases: ['ls'], run: () => ({ items: [] }) });

   export const program = defineCli({
     name: 'app',
     version: '1.0.0',
     commands: {
       users: group('Manage users', { list }),
     },
   });
   ```

2. `aliases: ['ls']` on a command adds another name at its level. A name that is also an alias at the same level makes `defineCli` throw.

### Return a failure

1. Define the failure once with `defineFailure` from `@arki/failure`; give it a `status` (503 makes it retryable) and a `remediation`.
2. Return it from `run`. Do not throw it.

   ```ts
   import { z } from 'zod';

   import { defineCommand } from '@arki/cli';
   import { defineFailure } from '@arki/failure';

   const UserNotFound = defineFailure('user.not_found', {
     status: 404,
     message: 'no user {id}',
     data: z.object({ id: z.string() }),
   });

   export default defineCommand({
     describe: 'Show one user',
     input: z.object({ id: z.string() }),
     args: ['id'],
     run: ({ input }) => (input.id === 'usr_ada' ? { id: input.id, name: 'Ada' } : UserNotFound({ id: input.id })),
   });
   ```

### Steps and arounds

1. List plain functions in `with: [...]`, in the order they run. They also wrap `preview`.
2. A step `(ctx) => object | Failure` adds the keys it returns to the context of what follows. A returned failure is the command's failure: same exit code and error output as a failure returned from `run`, and `run` never starts.
3. An around `(ctx, next) => Promise<T>` wraps everything after it and `run`, and returns what `next()` returns.
4. Runtime tells them apart by `fn.length >= 2`. Declare `next` as a plain second parameter: no default value, no rest parameter. Otherwise an around runs as a step.
5. Model shared by all transports: Steps and arounds (`docs/middleware.md` in `@arki/dot`).

### Offer a dry run

1. Add `preview(ctx)`: same input, same success type as `run`, no changes made.
2. `--dry-run` then runs `preview` and sets `meta.dryRun: true`. Without `preview`, `--dry-run` fails with `cli.preview_unsupported` (exit 2).

### Test a command

1. Call `main` with your own `io`; leave `tty` false to get the envelope.

   ```ts run
   import { z } from 'zod';

   import { defineCli, defineCommand } from '@arki/cli';

   const program = defineCli({
     name: 'app',
     version: '1.0.0',
     commands: {
       double: defineCommand({
         describe: 'Double a number',
         input: z.object({ value: z.number() }),
         args: ['value'],
         run: ({ input }) => ({ doubled: input.value * 2 }),
       }),
     },
   });

   let stdout = '';
   const exitCode = await program.main(['double', '21'], {
     stdout: text => {
       stdout += text;
     },
     tty: false,
   });
   if (exitCode !== 0 || !stdout.includes('"doubled":42')) throw new Error(stdout);
   ```

## Rules that bite

- No type arguments at call sites: `defineCommand` infers input from the schema and output from `run`, failures removed.
- `run` output goes to the envelope; use `ui.out` for text-mode lines and `ui.info`/`ui.warn` for stderr. They are silent in json mode.
- An input key named like a global flag (`output`, `json`, `fields`, `inputJson`, `inputFile`, `quiet`, `color`, `dryRun`, `help`, `version`) throws at definition time.
- Defaults belong to the schema. The parser leaves a missing flag out; validation fills it.
- `--input-json`/`--input-file` replace all flags; mixing is invalid input.
- An array key in `args` must be the last positional.
- A command written inline in a `defineCli` tree sees `ctx.services` as `unknown`; one in its own file sees `{}`.
- `run` configures nothing in `@arki/log`; configure logging in the bin file.

## Errors

| Code                        | Exit | Meaning                                              | What to do                                          |
| --------------------------- | ---- | ---------------------------------------------------- | --------------------------------------------------- |
| `cli.unknown_command`       | 2    | No command by that name at that level                | Use a name from `data.suggestions` or `--help`      |
| `cli.invalid_input`         | 2    | The command line does not fit the input schema       | Fix each flag in `error.issues`                     |
| `cli.preview_unsupported`   | 2    | `--dry-run` on a command without `preview`           | Run without `--dry-run`, or add `preview`           |
| `cli.input_required`        | 5    | A required value is missing and there is no terminal | Pass the flag in `data.flag`                        |
| `cli.confirmation_required` | 5    | Confirmation needed and there is no terminal         | Pass `--yes`                                        |
| `cli.cancelled`             | 130  | The run ended after SIGINT/SIGTERM                   | Check what changed (`outcome: unknown`), then rerun |
| `cli.bug`                   | 1    | Something threw                                      | Read the log for the stack; fix the command         |

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs
bun run test:runtimes
```
