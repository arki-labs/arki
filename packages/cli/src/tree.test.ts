/**
 * Resolution imports only the branch a command line takes: a slow or broken
 * sibling must never cost a command that does not use it. An unknown name
 * fails with the names a person most likely meant.
 */
import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import { defineCommand } from './command.js';
import { editDistance, group, resolvePath, suggestionsFor } from './tree.js';

const hello = defineCommand({ describe: 'hello', aliases: ['hi'], run: () => 'hello' });

function tree(loaded: string[]) {
  return group('root', {
    hello,
    users: () => {
      loaded.push('users');
      return Promise.resolve(group('users', { list: defineCommand({ describe: 'list', run: () => [] }) }));
    },
    broken: () => {
      loaded.push('broken');
      return Promise.reject(new Error('broken on import'));
    },
  });
}

describe('resolvePath', () => {
  it('imports only the lazy branch taken, never a sibling', async () => {
    const loaded: string[] = [];
    const resolved = await resolvePath(tree(loaded), ['users', 'list', '--json']);
    expect(isFailure(resolved)).toBe(false);
    if (isFailure(resolved)) return;
    expect(resolved.path).toEqual(['users', 'list']);
    expect(resolved.rest).toEqual(['--json']);
    expect(loaded).toEqual(['users']);
  });

  it('stops at the first flag: the rest is the command line of the node reached', async () => {
    const resolved = await resolvePath(tree([]), ['hello', 'world', '-q']);
    if (isFailure(resolved)) throw new Error(resolved.message);
    expect(resolved.path).toEqual(['hello']);
    expect(resolved.rest).toEqual(['world', '-q']);
  });

  it('resolves an alias, and a broken sibling does not stop it', async () => {
    const resolved = await resolvePath(tree([]), ['hi']);
    if (isFailure(resolved)) throw new Error(resolved.message);
    expect(resolved.node).toBe(hello);
  });

  it('fails an unknown name with close names and aliases as suggestions', async () => {
    const resolved = await resolvePath(tree([]), ['usres']);
    expect(isFailure(resolved) && resolved.code).toBe('cli.unknown_command');
    expect(isFailure(resolved) && resolved.data).toEqual({ received: 'usres', suggestions: ['users'] });
  });
});

describe('suggestions', () => {
  it('counts a swap of two letters as one edit (Damerau), so typos like "usres" are found', () => {
    expect(editDistance('usres', 'users')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('keeps names within distance 2, closest first, and drops the rest', () => {
    expect(suggestionsFor('lst', ['list', 'last', 'deploy', 'ls'])).toEqual(['last', 'list', 'ls']);
    expect(suggestionsFor('zzzzzz', ['list'])).toEqual([]);
  });
});
