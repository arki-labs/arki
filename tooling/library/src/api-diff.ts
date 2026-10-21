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
 * Grouped exports (see `arki-api-index`) are expanded through their names
 * files, so one added or removed name inside a group is reported like any
 * other. When the shared type of a group changes, the change is reported once
 * per group (`changedGroups`), not once per name.
 *
 * With `--docs`, the doc pages (`README.md`, `docs/**\/*.md`, `llms.txt`) of
 * that package are searched for each removed or changed name, as a whole word,
 * so a rename does not leave stale pages behind. Output lists `file:line`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import type { ApiEntry, ApiIndex, NamesReader } from './api-index';
import { apiEntrySchema, apiIndexSchema, API_KINDS, namesReaderFor } from './api-index';

/** A name on both sides whose signature differs; `from` and `to` are the two signatures. */
export const apiChangeSchema = z.object({ subpath: z.string(), name: z.string(), from: z.string(), to: z.string() });
/** Every name of a group whose shared type moved from `from` to `to`, reported once. */
export const apiGroupChangeSchema = z.object({
  subpath: z.string(),
  kind: z.enum(API_KINDS),
  from: z.string(),
  to: z.string(),
  count: z.number().int().positive(),
});
/** The `--json` output (minus `docMentions`); the upgrade guide reads it back with this schema. */
export const apiDiffSchema = z.object({
  added: z.array(apiEntrySchema),
  removed: z.array(apiEntrySchema),
  changed: z.array(apiChangeSchema),
  changedGroups: z.array(apiGroupChangeSchema),
});
export type ApiGroupChange = z.infer<typeof apiGroupChangeSchema>;
export type ApiChange = z.infer<typeof apiChangeSchema>;
export type ApiDiff = z.infer<typeof apiDiffSchema>;
export type DocMention = { readonly name: string; readonly file: string; readonly line: number };

const keyOf = (entry: { subpath: string; name: string }): string => `${entry.subpath}\u0000${entry.name}`;

/** One side of a comparison: the index plus a way to read its group names. */
export type ApiSide = { readonly index: ApiIndex; readonly namesOf: NamesReader };

type Member = ApiEntry & { readonly grouped: boolean };

/** Every export of one side by key: plain entries, then each group's names. */
function membersOf({ index, namesOf }: ApiSide): Map<string, Member> {
  const members = new Map<string, Member>();
  for (const entry of index.entries) members.set(keyOf(entry), { ...entry, grouped: false });
  for (const group of index.groups) {
    for (const name of namesOf(group)) {
      members.set(keyOf({ subpath: group.subpath, name }), {
        subpath: group.subpath,
        name,
        kind: group.kind,
        signature: group.signature,
        jsdocSummary: '',
        grouped: true,
      });
    }
  }
  return members;
}

/**
 * Same signature? A name that moved between a group and its own entry (the
 * group crossed the size threshold) is the same when the entry is the plain
 * `declare const` of the group's type, so no name is reported as changed for it.
 */
function sameSignature(before: Member, after: Member): boolean {
  if (before.signature === after.signature) return true;
  const [grouped, plain] = before.grouped ? [before, after] : [after, before];
  return grouped.grouped && !plain.grouped && plain.signature === `export declare const ${plain.name}: ${grouped.signature};`;
}

export function diffApi(from: ApiSide, to: ApiSide): ApiDiff {
  const before = membersOf(from);
  const after = membersOf(to);
  const plain = (member: Member): ApiEntry => ({
    subpath: member.subpath,
    name: member.name,
    kind: member.kind,
    signature: member.signature,
    jsdocSummary: member.jsdocSummary,
  });
  const added = [...after].filter(([key]) => !before.has(key)).map(([, member]) => plain(member));
  const removed = [...before].filter(([key]) => !after.has(key)).map(([, member]) => plain(member));
  const changed: ApiChange[] = [];
  const groupChanges = new Map<string, ApiGroupChange>();
  for (const [key, member] of after) {
    const old = before.get(key);
    if (!old || sameSignature(old, member)) continue;
    if (old.grouped && member.grouped) {
      const groupKey = `${member.subpath}\u0000${old.signature}\u0000${member.signature}`;
      const seen = groupChanges.get(groupKey);
      groupChanges.set(
        groupKey,
        seen
          ? { ...seen, count: seen.count + 1 }
          : { subpath: member.subpath, kind: member.kind, from: old.signature, to: member.signature, count: 1 },
      );
    } else {
      changed.push({ subpath: member.subpath, name: member.name, from: old.signature, to: member.signature });
    }
  }
  return { added, removed, changed, changedGroups: [...groupChanges.values()] };
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

const readSide = (file: string): ApiSide => ({
  index: apiIndexSchema.parse(JSON.parse(readFileSync(file, 'utf8'))),
  namesOf: namesReaderFor(file),
});

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, to: { type: 'string' }, docs: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (values.from === undefined || values.to === undefined) {
    process.stderr.write('usage: arki-api-diff --from <old.json> --to <new.json> [--docs <packageDir>] [--json]\n');
    return 2;
  }
  const diff = diffApi(readSide(values.from), readSide(values.to));
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
  for (const change of diff.changedGroups) {
    out.push(
      `~ ${change.subpath} ${change.count} ${change.kind} exports of one type`,
      `    was: ${change.from}`,
      `    now: ${change.to}`,
    );
  }
  for (const mention of mentions) out.push(`doc ${mention.file}:${mention.line} mentions ${mention.name}`);
  if (out.length === 0) out.push('arki-api-diff: no API changes');
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
