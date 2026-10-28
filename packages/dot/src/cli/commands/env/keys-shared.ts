/** The 1Password item a private key lives in: one Password item per repository and environment. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

import { keyNamesFor } from '@arki/env/node';
import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import { EnvVaultFailed, EnvVaultWriteUnconfirmed } from '../../env-failures.js';

export function vaultItemTitle(root: string, environment: string): string {
  return `${path.basename(root)} ${keyNamesFor(`.env.${environment}`).privateKey}`;
}

const itemId = z
  .string()
  .regex(/^[a-z2-7]{26}$/)
  .brand<'VaultItemId'>();
const itemList = z.array(z.object({ id: itemId, title: z.string() }));
const passwordItem = z
  .object({
    id: itemId,
    title: z.string(),
    category: z.literal('PASSWORD'),
    fields: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string(),
            purpose: z.string().optional(),
            value: z.string().optional(),
          })
          .passthrough(),
      )
      .refine(
        fields =>
          fields.filter(field => field.id === 'password').length === 1 &&
          fields.some(field => field.id === 'password' && field.purpose === 'PASSWORD' && field.type === 'CONCEALED'),
      ),
  })
  .passthrough();
const json = z.string().transform((text, context): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid provider JSON' });
    return z.NEVER;
  }
});
const listJson = json.pipe(itemList);
const passwordJson = json.pipe(passwordItem);

/** Reads have a bounded native-child lifetime; provider diagnostics remain private. */
export function op(args: readonly string[]) {
  try {
    return execFileSync('op', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    return EnvVaultFailed(
      { reason: 'The CLI read failed; check installation, sign-in and vault access' },
      { cause: error },
    );
  }
}

/** Only a successful, valid list confirms absence. A title never selects a mutation target. */
export function readVaultItem(vault: string, title: string) {
  const listed = op(['item', 'list', `--vault=${vault}`, '--format=json']);
  if (isFailure(listed)) return listed;
  const items = parse(listJson, listed);
  if (isFailure(items)) return EnvVaultFailed({ reason: 'The CLI returned an invalid item list' }, { cause: items });
  const matches = items.filter(item => item.title === title);
  if (matches.length > 1)
    return EnvVaultFailed({
      reason: 'Multiple items have the backup title; reconcile them in 1Password before retrying',
    });
  const match = matches[0];
  if (match === undefined) return;
  const read = op(['item', 'get', match.id, `--vault=${vault}`, '--format=json', '--reveal']);
  if (isFailure(read)) return read;
  const item = parse(passwordJson, read);
  if (isFailure(item))
    return EnvVaultFailed(
      { reason: 'The backup must be a Password item with one concealed password field' },
      { cause: item },
    );
  if (item.id !== match.id || item.title !== title)
    return EnvVaultFailed({ reason: 'The backup identity changed; reread the vault before retrying' });
  return item;
}

/** Write once. Lost/rejected acknowledgments require a fresh provider read before any replay. */
export function writeVaultItem(
  vault: string,
  title: string,
  privateKey: string,
  existing: z.output<typeof passwordItem> | undefined,
) {
  const operation = existing === undefined ? 'create' : 'edit';
  const item =
    existing === undefined
      ? {
          title,
          category: 'PASSWORD',
          fields: [{ id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: privateKey }],
        }
      : {
          ...existing,
          fields: existing.fields.map(field => (field.id === 'password' ? { ...field, value: privateKey } : field)),
        };
  const args =
    existing === undefined
      ? ['item', 'create', '-', `--vault=${vault}`, '--format=json', '--reveal']
      : ['item', 'edit', existing.id, `--vault=${vault}`, '--format=json', '--reveal'];
  try {
    const out = execFileSync('op', args, {
      encoding: 'utf8',
      input: JSON.stringify(item),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    const confirmed = parse(passwordJson, out);
    if (isFailure(confirmed)) return EnvVaultWriteUnconfirmed({ operation }, { cause: confirmed });
    if (
      confirmed.title !== title ||
      (existing !== undefined && confirmed.id !== existing.id) ||
      confirmed.fields.find(field => field.id === 'password')?.value !== privateKey
    ) {
      return EnvVaultWriteUnconfirmed({ operation });
    }
    return confirmed;
  } catch (error) {
    return EnvVaultWriteUnconfirmed({ operation }, { cause: error });
  }
}
