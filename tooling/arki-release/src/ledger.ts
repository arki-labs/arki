/**
 * The human release ledger, `docs/releases/RELEASES.md`.
 *
 * `ship --finish` writes one entry per shipped candidate, generated from
 * `candidate.json` so the ledger never disagrees with the bytes that were
 * verified on npm. Entries go newest first, right below the intro block.
 * Each entry carries a `<!-- candidate: <id> -->` marker, so a resumed
 * `--finish` never writes the same entry twice.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { Candidate } from './candidate';

export const LEDGER_PATH = path.join('docs', 'releases', 'RELEASES.md');

const scorecardSummarySchema = z.object({
  stableReleaseGate: z.enum(['open', 'blocked']),
  pass: z.number(),
  warn: z.number(),
  fail: z.number(),
  deferred: z.number(),
});

export interface LedgerEntryInput {
  readonly candidate: Candidate;
  /** Candidate folder name, e.g. `foundation-abc1234`. */
  readonly candidateId: string;
  /** Human wave label from the config. */
  readonly waveLabel: string;
  readonly date: Date;
}

function marker(candidateId: string): string {
  return `<!-- candidate: ${candidateId} -->`;
}

/** Markdown for one shipped candidate. Pure. */
export function renderLedgerEntry(input: LedgerEntryInput): string {
  const { candidate } = input;
  const day = input.date.toISOString().slice(0, 10);
  const packages = [...candidate.packages].sort((a, b) => a.publishOrder - b.publishOrder);
  const scorecard = scorecardSummarySchema.safeParse(candidate.checks['scorecard']?.envelope);
  const verdict = scorecard.success
    ? `\`${scorecard.data.stableReleaseGate.toUpperCase()}\` (${String(scorecard.data.pass)} pass, ${String(scorecard.data.warn)} warn, ${String(scorecard.data.fail)} fail, ${String(scorecard.data.deferred)} deferred)`
    : 'not recorded in candidate.json';
  const checks = Object.entries(candidate.checks)
    .filter(([id]) => id !== 'shipped')
    .map(([id, check]) => `\`${id}\` ${check.status}`)
    .sort();
  return [
    `## ${input.waveLabel} (${candidate.wave}) @ ${candidate.sourceCommit.slice(0, 7)} (${day})`,
    '',
    marker(input.candidateId),
    '',
    `**Packages shipped** (${String(packages.length)}, in publish order):`,
    '',
    '| Package | Version | Order |',
    '| ------- | ------- | ----- |',
    ...packages.map(p => `| ${p.name} | ${p.version} | ${String(p.publishOrder)} |`),
    '',
    `**Source commit**: \`${candidate.sourceCommit}\`. Tarballs verified on npm by \`dist.integrity\`.`,
    '',
    `**Scorecard at publish**: ${verdict}.`,
    '',
    `**Candidate checks**: ${checks.length > 0 ? checks.join(', ') : 'none recorded'}.`,
    '',
    `**GitHub mirror**: \`sync --apply\` runs after this entry; its result is \`checks.sync\` in \`.release/candidates/${input.candidateId}/candidate.json\`.`,
    '',
  ].join('\n');
}

export type LedgerWrite = 'written' | 'exists';

/**
 * Inserts the entry newest-first: after the intro block that ends with the
 * first `---` rule. Appends at the end when the file has no rule.
 */
export async function writeLedgerEntry(file: string, entry: string, candidateId: string): Promise<LedgerWrite> {
  const current = await readFile(file, 'utf8');
  if (current.includes(marker(candidateId))) return 'exists';
  const rule = '\n---\n';
  const at = current.indexOf(rule);
  const next =
    at === -1
      ? `${current.trimEnd()}\n\n${entry}`
      : `${current.slice(0, at + rule.length)}\n${entry}\n---\n${current.slice(at + rule.length)}`;
  // Write then rename so a crash never leaves a half-written ledger.
  const temp = `${file}.tmp`;
  await writeFile(temp, next);
  await rename(temp, file);
  return 'written';
}
