/** The 1Password item a private key lives in: one Password item per repository and environment. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { z } from 'zod';

import { keyNamesFor } from '@arki/env/node';

export function vaultItemTitle(root: string, environment: string): string {
  return `${path.basename(root)} ${keyNamesFor(`.env.${environment}`).privateKey}`;
}

const execError = z.object({ code: z.string().optional(), stderr: z.string().optional() });

/** Run `op`; the error is the first line of its stderr. Input goes through stdin, never argv. */
export function op(args: readonly string[], input?: string): { ok: true; out: string } | { ok: false; reason: string } {
  try {
    const out = execFileSync('op', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    return { ok: true, out };
  } catch (error) {
    const parsed = execError.safeParse(error);
    if (parsed.success && parsed.data.code === 'ENOENT') return { ok: false, reason: 'the 1Password CLI (`op`) is not installed' };
    const line = parsed.success ? parsed.data.stderr?.trim().split('\n')[0] : undefined;
    return { ok: false, reason: line === undefined || line === '' ? 'op failed' : line };
  }
}
