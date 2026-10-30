# The `dot` command

`dot` scaffolds, inspects and runs Dot apps. Every command prints the
`arki.cli/1` JSON envelope when piped or with `--json`, and text on a
terminal. For a guided first run, see the [Quickstart](./quickstart.md).

| Command       | Side effects                                                                               |
| ------------- | ------------------------------------------------------------------------------------------ |
| `dot explain` | Imports the app file and runs `configure`. Never boots.                                    |
| `dot doctor`  | Boots the app (`boot` hooks run, migrations apply), then disposes it. Never calls `start`. |
| `dot new`     | Writes files under the target directory. `--dry-run` writes nothing.                       |
| `dot dev`     | Starts a database, applies migrations, runs the app, watches files.                        |

`@arki/dot` ships a small CLI for scaffolding and inspecting apps:

```bash
# Scaffold a full-stack app: TanStack Start + oRPC + Postgres (@arki/db)
# + @arki/journal + @arki/ui, with Dockerfile, migrations and tests.
dot new pizzeria

# Scaffold the smallest DOT app instead (defineApp + env, vitest boot test).
dot new pizzeria --template minimal

# Preview the file operations without writing anything.
dot new pizzeria --dry-run --json | jq '.operations'

# Print the app manifest as a structured envelope.
dot explain --app ./pizzeria.ts

# Run boot-time diagnostics; exit 3 (dot.doctor_failed) if any check fails.
dot doctor --app ./pizzeria.ts

# Render the unit graph as Mermaid flowchart source. explain shows
# declaration (= boot) order; doctor boots and shows the OBSERVED wiring.
dot doctor --app ./pizzeria.ts --graph

# Every command supports --json for agent-friendly output.
dot explain --app ./pizzeria.ts --json | jq '.data.plugins'
```

The CLI emits the same envelope shape as the in-process diagnostics snapshot
(`app.diagnostics`), so the same downstream tools can consume either. Edges
between features are derived before boot from their static `provides` and
carry the capability `key`, so `explain` shows them; the rest are **observed** —
the kernel records which unit's published service satisfied which need
during boot.

## `dot dev`

One command for local development: database, env, migrations, the app, file
watching.

```bash
dot dev                 # PGlite or local Postgres, migrations, then Vite
dot dev --once --json   # preflight only: exit 0 when env, migrations and boot pass (CI, agents)
```

```text
dot dev ▸ app (src/app.ts, export dev)  graph: 7 units, 0 features
dot dev ▸ db: pglite (embedded)
dot dev ▸ migrations: 1 pending (20261014000000_init), applied by the preflight
dot dev ▸ preflight: doctor OK
dot dev ▸ runner: vite dev --port 3000 --strictPort (pid 4121)
```

- **The `dev` export.** `dot dev` picks `export const dev` (an unstarted
  builder) over `default`. The stack template exports `dev` on an embedded
  PGlite database in `./.local/db`. A started app is refused
  (`dot.dev_app_started`).
- **Order.** It resolves the database, then runs a preflight in a fresh process
  (`dot _preflight`, with the runner's env). The preflight is `dot doctor`'s
  boot: it validates env and applies the committed `drizzle/` migrations
  through `dbMigrations`. It prints the migrations that boot applied, then
  disposes the app. Every restart runs a new preflight process, so it checks
  the code and env as they are now. A preflight that crashes, hangs or prints
  no report fails (`dot.dev_preflight_failed`). A reported lifecycle failure uses
  `dot.preflight_failed` (exit 3): failed JSON reports live under
  `.error.data.{app,migrations,report,failure}`; successful `.data` paths stay unchanged. Only then does it start
  the runner. A failed preflight prints the doctor text and starts nothing.
- **Database.** `--db auto` (the default) means Postgres when `DB_URL` /
  `DATABASE_URL` is set (process env or `.env`, `.env.local`, `.env.development`,
  `.env.development.local`), else PGlite. Under PGlite the runner starts with
  every database URL removed, and a Bun runner gets `--no-env-file` so it
  cannot load them back.
  - Fail closed: every URL value in any of those files or the process env must
    point at this machine (or a compose service that resolves to loopback),
    under PGlite too.
  - A URL whose host is not this machine or a compose service is refused
    (`dot.dev_remote_db_refused`) unless you pass `--allow-remote-db`.
  - A local Postgres that is down is started with
    `docker compose up -d <service>`. `dot dev` never stops or deletes volumes.
- **Runner.** `--run "<cmd>"` wins. Otherwise `vite dev` when a
  `vite.config.*` exists, else the hidden `dot _serve`, which starts the app
  itself. The runner gets its own process group. On exit it receives SIGTERM,
  then SIGKILL after 10 s.
- **Watch.** A change in `drizzle/`, `.env*` or the app file stops the runner
  and repeats the database step, the preflight and the runner. Under Vite, other
  `src/` changes are left to Vite's hot reload (`createAppRuntime`). A crashed
  app is not restarted until a change or `r`.
- **One per folder.** `.local/dot/dev.json` names the running session. A second
  `dot dev` in the same folder gets `dot.dev_already_running`.
- **Keys** (terminal only): `q` quit, `r` restart, `c` open the console,
  `d` print the last preflight report.
- **Flags:** `--app`, `--cwd`, `--db auto|pglite|pg`, `--allow-remote-db`,
  `--port` (3000), `--console-port` (4321), `--no-console`, `--no-open`,
  `--once`, `--run`.
- **Failure codes:** `dot.dev_db_unreachable`, `dot.dev_runner_failed`,
  `dot.dev_port_in_use`, `dot.dev_already_running`,
  `dot.dev_remote_db_refused`, `dot.dev_app_started`, `dot.dev_preflight_failed`. With `--output ndjson`,
  the events (`app`, `db`, `migrations`, `preflight`, `runner`, `console`,
  `restart`, `exit`) print one per line when the session ends.

## `dot new <app-name>`

Scaffolds an app under `<app-name>/` (override with `--target`). Pick the
starting point with `--template`:

- **`stack`** (default) — a full-stack app in one package: TanStack Start
  (React, Vite, Nitro), an oRPC API at `/api/rpc`, Postgres through
  `@arki/db`, every write through an `@arki/journal` command (an audit
  trail), all composed with `defineApp`. UI uses `@arki/ui` with the
  workbench design system. It ships one feature end to end (`notes`), an
  initial migration, `/api/health`, a `docker-compose.yml` for local
  Postgres, a production `Dockerfile`, tests on in-memory PGlite (no
  Docker), and a README + AGENTS.md. Run it with `bun install`,
  `cp .env.example .env`, `docker compose up -d`, `bun run dev`.
- **`minimal`** — a `defineApp(...)` entrypoint wired to `@arki/dot/env`,
  a vitest that boots the app and asserts the manifest shape, and an
  `AGENTS.md` documenting verification commands.

An unknown template name fails with `cli.invalid_input` (exit 2). Pass `--dry-run --json`
to inspect the exact file operations (path, action, contentHash,
contentBytes, reason) before committing them to disk; `--force`
overwrites pre-existing files in the target directory.

Templates live in [`templates/`](../templates) and ship with the published
tarball. Generated apps depend only on published `@arki/*` packages.

## `dot env`

Encrypted env files (dotenvx 2.x format) through `@arki/env/node`. Commit
`.env.<environment>`; keep `.env.keys`, `.env.local` and bare `.env` untracked.
No subcommand prints a value unless you ask for it in a terminal.

| Command | What it does |
| --- | --- |
| `dot env init [--env <e>]` | Adds the public key header and writes the private key to `.env.keys`. Adds `.env.keys*` to `.gitignore` and denies agents reading it. |
| `dot env set <KEY> --stdin` | Stores the value encrypted. `--plain` stores it as text, refused for a `secret()` key. |
| `dot env get <KEY>` | Prints the shape (`url`, `hex`, …). `--reveal` prints the value, in a terminal only. |
| `dot env ls` | Keys, kinds and which ones the schema declares, never values. |
| `dot env explain <KEY>` | The file, line and key source that a value comes from. |
| `dot env encrypt` | Encrypts plain values in place. `--from .env --all` imports an old file. |
| `dot env decrypt` | Writes plaintext back; refused for a tracked file. |
| `dot env rotate` | New keypair; every value encrypted again. |
| `dot env run -- <cmd>` | Runs a command with the files loaded. Strips private keys from the child. Redacts secrets in its output when stdout is not a terminal. Passes the exit code through, with no envelope. |
| `dot env check` | The CI gate: load errors, refused keys, a tracked `.env.keys`, a plaintext `secret()` value in a tracked file. |
| `dot env keys push --vault <v>` / `keys pull` | Backs up or restores private keys in 1Password. |

`check`, `ls`, `set` and `encrypt` import the app's `src/env.ts` to read its
`secret()` keys, with validation skipped. Node cannot import TypeScript, so
under Node they report `dot.env.schema_unavailable`. Run them under Bun
(`bun --bun dot env check`). `check` fails closed when that happens and a
tracked file has a plain value.

`dot dev` opens encrypted values in the app's env files with the same keys
before its database check.

### `dot env` failures

Each failure is exported from `@arki/dot/cli`. It comes back in the `error` field of the JSON envelope. Branch on `.error.code`. No message ever holds a value.

| Failure | Code | When it is returned | How to fix it |
| --- | --- | --- | --- |
| `EnvCheckFailed` | `dot.env_check_failed` | `dot env check` found at least one error. | Work through `.error.data.findings`; each has its own `remediation`. Run `check` again. |
| `EnvLoadFailed` | `dot.env_load_failed` | The env files cannot load: a private key is missing, a value cannot be decrypted, or a reference cannot be resolved. | Read each entry in `.error.data.errors` (codes `ARKI_ENV_FILES_E00x`). Restore the key with `dot env keys pull` or export `DOTENV_PRIVATE_KEY_<ENV>`. |
| `EnvNoChange` | `dot.env_no_change` | The command would write nothing: the value is already there, or there was nothing to encrypt or decrypt. | Read `.error.data.reason`. A variable exported in the shell does not change the file. Check `--env` and `--file`. |
| `EnvNoHeader` | `dot.env_no_header` | The file has no public key header, so values cannot be encrypted into it. | Run `dot env init` with the same `--env` or `--file`. |
| `EnvPlainSecret` | `dot.env_plain_secret` | `--plain` was used on a key that the env schema declares with `secret()`. | Run the same command without `--plain`. |
| `EnvKeyNotFound` | `dot.env_key_not_found` | The key is in none of the loaded env files. | Check the name and `--env`. `dot env ls` lists the keys; `dot env set <KEY>` adds one. |
| `EnvRevealRefused` | `dot.env_reveal_refused` | A value was asked for where it would leave the terminal (a pipe, a file, an agent transcript). | Use `dot env get <KEY> --reveal` in an interactive terminal. To give the value to a program, use `dot env run -- <cmd>`. |
| `EnvDecryptTracked` | `dot.env_decrypt_tracked` | `dot env decrypt` would write plaintext secrets into a file that git tracks. | Read one value with `--reveal`, or pass `--force` and do not commit the result. |
| `EnvValueMissing` | `dot.env_value_missing` | `dot env set` got the value from both an argument and `--stdin`, or from neither. | Give exactly one. Prefer `--stdin`; an argument stays in shell history. |
| `EnvCommandFailed` | `dot.env_command_failed` | The command after `--` in `dot env run` could not start. | Check that the command exists on PATH and comes after `--`. |
| `EnvVaultFailed` | `dot.env_vault_failed` | The 1Password CLI (`op`) failed or is not signed in during `keys push` or `keys pull`. | Install `op`, run `op signin`, and check `--vault`. |
| `EnvVaultWriteUnconfirmed` | `dot.env_vault_write_unconfirmed` | A 1Password create or edit was sent but its result was not confirmed. `.error.data.operation` says which. | Read the item in 1Password first; the write may have landed. A repeated `keys push` rereads the vault and accepts a matching key. Never blindly repeat a create or edit. |

## Other `dot.*` failures and helpers

Every failure below is exported from `@arki/dot/cli` and comes back in the
`error` field of the JSON envelope.

- `DoctorFailed` (`dot.doctor_failed`): `dot doctor` found error issues. The whole report is in `.error.data`.
  When a unit fails to boot, its issue keeps the outer code `ARKI_DOT_E003`. The issue `message` now ends with the unit's own failure message, and `metadata.failureCode` holds the unit's failure code (for example `ai.provider_unavailable`). A thrown error still shows only the generic defect message.
- `PreflightFailed` (`dot.preflight_failed`): a managed preflight reported a lifecycle failure. The report is in `.error.data`.
- `ObservabilityNoSdk` (`dot.observability_no_sdk`): `dot doctor --observability` found no OpenTelemetry SDK. It shows up as a warning issue, not as a returned failure.
- `ProjectionNotFound` (`dot.projection_not_found`): no unit registers the `--as` format you asked for.
- `ProjectionImportFailed` (`dot.projection_import_failed`): the projection module could not be resolved or imported, or it exports no `project(manifest)`.
- `ProjectionExecutionFailed` (`dot.projection_execution_failed`): `project(manifest)` threw, or returned output that does not survive a JSON round trip.
- `ProjectionConflict` (`dot.projection_conflict`): two units register different modules for the same projection format.
- `TargetNotEmpty` (`dot.target_not_empty`): `dot new` would overwrite files in a target directory that is not empty. Use an empty directory or `--force`.
- `TemplateMissing` (`dot.template_missing`): the template folder shipped with `@arki/dot` is empty or missing. Reinstall the package.
- `WriteFailed` (`dot.write_failed`): `dot new` could not write some files. `.error.data.written` lists the files that did land.

Two schemas parse the files `dot dev` produces. `devEventSchema` parses one
`dot dev` event. `devStateSchema` parses `.local/dot/dev.json`, the state file
at `DEV_STATE_PATH`.
