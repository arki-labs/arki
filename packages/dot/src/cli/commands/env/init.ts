/** `dot env init`: give an env file a public key header, and keep private keys out of git and agents. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { initEnvFile } from '@arki/env/node';
import { is } from '@arki/schema';

import { envTargetInput, relative, resolveTarget } from '../../env-files.js';

const KEYS_IGNORE = '.env.keys*';
const AGENT_DENY = ['Read(**/.env.keys)', 'Read(**/.env.keys.*)'] as const;

const claudeSettings = z.object({ permissions: z.object({ deny: z.array(z.string()).optional() }).loose().optional() }).loose();

export default defineCommand({
  describe: 'Add a public key header to an env file; reuse or create the private key',
  input: z.object(envTargetInput),
  effects: 'idempotent',
  examples: ['dot env init', 'dot env init --env production', 'dot env init --file ../.env.development'],
  run({ input }) {
    const target = resolveTarget(input);
    const result = initEnvFile(target.file, { root: target.root });
    return {
      file: relative(target.root, result.file),
      publicKey: result.publicKey,
      headerAdded: result.headerAdded,
      keysWritten: result.keysWritten === undefined ? null : relative(target.root, result.keysWritten),
      gitignore: ensureIgnored(path.join(target.root, '.gitignore')),
      agentDeny: ensureAgentDeny(path.join(target.root, '.claude', 'settings.json')),
    };
  },
  render(data, ui) {
    ui.out(data.headerAdded ? `${data.file}: header added` : `${data.file}: already initialised`);
    if (data.keysWritten !== null) ui.out(`private key written to ${data.keysWritten} (back it up: dot env keys push --vault <vault>)`);
    ui.out(`.gitignore: ${data.gitignore}; agent read-deny for .env.keys: ${data.agentDeny}`);
  },
});

function ensureIgnored(file: string): 'added' | 'present' {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').some(line => ['.env.keys', KEYS_IGNORE].includes(line.trim()))) return 'present';
  writeFileSync(file, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${KEYS_IGNORE}\n`);
  return 'added';
}

function ensureAgentDeny(file: string): 'added' | 'present' | 'no-settings' {
  if (!existsSync(path.dirname(file))) return 'no-settings';
  const settings: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  // `is` narrows the parsed file itself: a schema-parsed copy lists known keys first and would reorder it.
  if (!is(settings, claudeSettings)) return 'no-settings';
  const deny = settings.permissions?.deny ?? [];
  const missing = AGENT_DENY.filter(rule => !deny.includes(rule));
  if (missing.length === 0) return 'present';
  const next = { ...settings, permissions: { ...settings.permissions, deny: [...deny, ...missing] } };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return 'added';
}
