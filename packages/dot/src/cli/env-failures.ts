/**
 * The failures `dot env` returns. Each code is stable: agents branch on `.error.code`. Messages
 * name keys and files, never a value. Data schemas are Zod (A-39: schemas own validation).
 */
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

const finding = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  remediation: z.string(),
  file: z.string().optional(),
  key: z.string().optional(),
});

/** One `dot env check` finding. */
export type EnvFinding = z.output<typeof finding>;

/**
 * `dot env check` found at least one error.
 * @fix Work through `.error.data.findings`; each has its own `remediation`.
 * @verify dot env check --json | jq -e .ok
 */
export const EnvCheckFailed = defineFailure('dot.env_check_failed', {
  data: z.object({ findings: z.array(finding) }),
  message: 'The env files failed their check',
  remediation: 'Fix each finding in .error.data.findings, then run `dot env check` again.',
});

/**
 * The env files could not be loaded: a private key is missing, a value cannot be decrypted, or a reference cannot be resolved.
 * @fix Follow the message of each entry in `.error.data.errors` (codes `ARKI_ENV_FILES_E00x`).
 * @verify dot env check --json | jq -e .ok
 */
export const EnvLoadFailed = defineFailure('dot.env_load_failed', {
  data: z.object({ errors: z.array(z.object({ code: z.string(), message: z.string(), file: z.string(), key: z.string().optional() })) }),
  message: 'Cannot load the env files',
  remediation: 'Restore the private key (`dot env keys pull`, or export DOTENV_PRIVATE_KEY_<ENV>), then retry.',
});

/**
 * The command would write nothing: the value is already there, or there was nothing to encrypt or decrypt.
 * @fix Read `.error.data.reason`; a variable exported in the shell does not change the file.
 * @verify dot env ls --json
 */
export const EnvNoChange = defineFailure('dot.env_no_change', {
  data: z.object({ file: z.string(), reason: z.string() }),
  message: 'Nothing changed in {file}: {reason}',
  remediation: 'Check the key name and the target file (`--env`, `--file`); `dot env ls` lists what the file holds.',
});

/**
 * The file has no dotenvx public key header, so values cannot be encrypted into it.
 * @fix Run `dot env init` with the same `--env`/`--file`.
 * @verify dot env ls --json
 */
export const EnvNoHeader = defineFailure('dot.env_no_header', {
  data: z.object({ file: z.string() }),
  message: '{file} has no public key header',
  remediation: 'Run `dot env init` for this file first.',
});

/**
 * `--plain` was asked for a key the env schema declares with `secret()`.
 * @fix Drop `--plain`: a secret must be encrypted in a tracked file.
 * @verify dot env check --json | jq -e .ok
 */
export const EnvPlainSecret = defineFailure('dot.env_plain_secret', {
  data: z.object({ key: z.string() }),
  message: '{key} is declared secret(), so it cannot be stored as plaintext',
  remediation: 'Run the same command without --plain.',
});

/**
 * The key is in none of the loaded env files.
 * @fix Check the name and `--env`; `dot env ls` lists the keys.
 * @verify dot env ls --json
 */
export const EnvKeyNotFound = defineFailure('dot.env_key_not_found', {
  data: z.object({ key: z.string(), environment: z.string() }),
  message: '{key} is not set in any {environment} env file',
  remediation: 'Run `dot env ls` to see the keys, or `dot env set <KEY>` to add it.',
});

/**
 * A value was asked for where it would leave the terminal (a pipe, a file, an agent's transcript).
 * @fix Run `dot env get <KEY> --reveal` in an interactive terminal, or `dot env run -- <cmd>` to hand values to a process.
 * @verify dot env get <KEY> --json
 */
export const EnvRevealRefused = defineFailure('dot.env_reveal_refused', {
  data: z.object({ key: z.string() }),
  message: 'Refusing to print {key} outside an interactive terminal',
  remediation: 'Use --reveal only on a terminal; to give the value to a program, use `dot env run -- <cmd>`.',
});

/**
 * Decrypting a tracked file would put plaintext secrets one `git add` away from a commit.
 * @fix Pass `--force` if you really mean it, and do not commit the result.
 * @verify git diff --stat
 */
export const EnvDecryptTracked = defineFailure('dot.env_decrypt_tracked', {
  data: z.object({ file: z.string() }),
  message: '{file} is tracked by git; decrypting it in place is refused',
  remediation: 'Use `dot env get <KEY> --reveal` to read one value, or pass --force.',
});

/**
 * The value came from both a positional argument and `--stdin`, or from neither.
 * @fix Give exactly one: `dot env set KEY value`, or `printf %s "$VALUE" | dot env set KEY --stdin`.
 * @verify dot env ls --json
 */
export const EnvValueMissing = defineFailure('dot.env_value_missing', {
  data: z.object({ key: z.string() }),
  message: 'Give the value of {key} either as an argument or with --stdin, not both or neither',
  remediation: 'Prefer --stdin: an argument stays in the shell history.',
});

/**
 * The command after `--` could not be started.
 * @fix Check the command name and PATH.
 * @verify dot env run -- node --version
 */
export const EnvCommandFailed = defineFailure('dot.env_command_failed', {
  data: z.object({ command: z.string(), reason: z.string() }),
  message: 'Cannot start {command}: {reason}',
  remediation: 'Check that the command exists on PATH; put it after `--`.',
});

/**
 * The 1Password CLI (`op`) failed or is not signed in.
 * @fix Install `op`, sign in (`op signin`), and check the vault name.
 * @verify op vault list
 */
export const EnvVaultFailed = defineFailure('dot.env_vault_failed', {
  data: z.object({ reason: z.string() }),
  message: '1Password: {reason}',
  remediation: 'Sign in with `op signin` and check `--vault`.',
});

/**
 * A vault write was attempted but its result was not confirmed.
 * @fix Read the item from 1Password before retrying; the write may already have completed.
 * @verify dot env keys push --vault <vault> --json
 */
export const EnvVaultWriteUnconfirmed = defineFailure('dot.env_vault_write_unconfirmed', {
  data: z.object({ operation: z.enum(['create', 'edit']) }),
  message: '1Password {operation} result is unconfirmed',
  remediation:
    'Reconcile by reading the item in 1Password before retrying. A repeated push rereads the vault and accepts an already matching key; never blindly repeat a create or edit.',
});
