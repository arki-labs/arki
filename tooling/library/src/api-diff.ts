#!/usr/bin/env bun
/**
 * `arki-api-diff`: compares two `api.json` files (from `arki-api-index`).
 *
 *   arki-api-diff --from <old.json> --to <new.json> [--docs <packageDir>] [--json]
 *
 * An entry is identified by subpath plus name. It is *added* or *removed* when
 * only one side has it, and *changed* when its signature differs. A kind
 * change shows up as a changed signature too.
 *
 * With `--docs`, the doc pages (`README.md`, `docs/**\/*.md`, `llms.txt`) of
 * that package are searched for each removed or changed name, as a whole word,
 * so a rename does not leave stale pages behind. Output lists `file:line`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import type { ApiIndex } from './api-index';
import { apiEntrySchema, apiIndexSchema } from './api-index';

/** A name on both sides whose signature differs; `from` and `to` are the two signatures. */
export const apiChangeSchema = z.object({ subpath: z.string(), name: z.string(), from: z.string(), to: z.string() });
/** The `--json` output (minus `docMentions`); the upgrade guide reads it back with this schema. */
export const apiDiffSchema = z.object({
  added: z.array(apiEntrySchema),
  removed: z.array(apiEntrySchema),
  changed: z.array(apiChangeSchema),
});
export type ApiChange = z.infer<typeof apiChangeSchema>;
export type ApiDiff = z.infer<typeof apiDiffSchema>;
export type DocMention = { readonly name: string; readonly file: string; readonly line: number };

const keyOf = (entry: { subpath: string; name: string }): string => `${entry.subpath}\u0000${entry.name}`;

export function diffApi(from: ApiIndex, to: ApiIndex): ApiDiff {
  const before = new Map(from.entries.map(entry => [keyOf(entry), entry]));
  const after = new Map(to.entries.map(entry => [keyOf(entry), entry]));
  const added = to.entries.filter(entry => !before.has(keyOf(entry)));
  const removed = from.entries.filter(entry => !after.has(keyOf(entry)));
  const changed: ApiChange[] = [];
  for (const entry of to.entries) {
    const old = before.get(keyOf(entry));
    if (old && old.signature !== entry.signature) {
      changed.push({ subpath: entry.subpath, name: entry.name, from: old.signature, to: entry.signature });
    }
  }
  return { added, removed, changed };
}

function docFiles(packageDir: string): string[] {
  const found: string[] = [];
  for (const top of ['README.md', 'llms.txt']) {
    if (existsSync(path.join(packageDir, top))) found.push(path.join(packageDir, top));
  }
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir).toSorted()) {
      const full = path.join(dir, item);
      if (statSync(full).isDirectory()) walk(full);
      else if (item.endsWith('.md')) found.push(full);
    }
  };
  walk(path.join(packageDir, 'docs'));
  return found;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lines in the package's doc pages that mention any of `names` as a whole word. */
export function findDocMentions(packageDir: string, names: readonly string[]): DocMention[] {
  const unique = [...new Set(names)];
  const patterns = unique.map(name => ({ name, pattern: new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`) }));
  const mentions: DocMention[] = [];
  for (const file of docFiles(packageDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const { name, pattern } of patterns) {
        if (pattern.test(text)) mentions.push({ name, file: path.relative(packageDir, file), line: index + 1 });
      }
    });
  }
  return mentions;
}

const readIndex = (file: string): ApiIndex => apiIndexSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, to: { type: 'string' }, docs: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (values.from === undefined || values.to === undefined) {
    process.stderr.write('usage: arki-api-diff --from <old.json> --to <new.json> [--docs <packageDir>] [--json]\n');
    return 2;
  }
  const diff = diffApi(readIndex(values.from), readIndex(values.to));
  const mentions =
    values.docs === undefined
      ? []
      : findDocMentions(values.docs, [...diff.removed.map(e => e.name), ...diff.changed.map(c => c.name)]);

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ...diff, docMentions: mentions }, null, 2)}\n`);
    return 0;
  }
  const out: string[] = [];
  for (const entry of diff.added) out.push(`+ ${entry.subpath} ${entry.name} (${entry.kind})`);
  for (const entry of diff.removed) out.push(`- ${entry.subpath} ${entry.name} (${entry.kind})`);
  for (const change of diff.changed) {
    out.push(`~ ${change.subpath} ${change.name}`, `    was: ${change.from}`, `    now: ${change.to}`);
  }
  for (const mention of mentions) out.push(`doc ${mention.file}:${mention.line} mentions ${mention.name}`);
  if (out.length === 0) out.push('arki-api-diff: no API changes');
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
