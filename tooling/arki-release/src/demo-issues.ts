/**
 * `demo issues` (T4.4): turn the open rows of a demo's `docs/lib-gaps.md`
 * into GitHub issues on `arki-labs/arki`.
 *
 * Two halves, split by who may run them (same split as `sync`):
 *   --prepare  local, agent-safe: parses the rows and writes
 *              `.release/demo-issues/<demo>.json`.
 *   --apply    founder only: runs `gh issue create` per open row without an
 *              issue link, then writes the issue link back into that row.
 *
 * The same row parser feeds `packages.json.openGaps` (see `site.ts`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import debugFactory from 'debug';
import { z } from 'zod';

import type { ExecRunner } from './runners';
import type { ReleaseCommandEnvelope, ReleaseConfig, ReleaseError } from './types';
import { createEnvelope } from './json-output';
import { execRunner } from './runners';

const debug = debugFactory('arki:release:demo-issues');

export const DEMO_ISSUES_ERROR_CODES = {
  /** Apply refused: an agent session is running. */
  agentSession: 'DEMOISS_E001',
  /** Apply refused: stdin is not a terminal. */
  notTerminal: 'DEMOISS_E002',
  /** `--demo` names no demo in `arki.release.config.ts`. */
  unknownDemo: 'DEMOISS_E003',
  /** The demo's `docs/lib-gaps.md` is missing or has no rows. */
  noGapsFile: 'DEMOISS_E004',
  /** The prepared file is missing or does not match its schema. */
  preparedUnreadable: 'DEMOISS_E005',
  /** `gh issue create` failed or printed no issue URL. */
  ghFailed: 'DEMOISS_E006',
  /** The row to write the link into moved or changed since `--prepare`. */
  rowMoved: 'DEMOISS_E007',
} as const;

const COMMAND = 'demo' as const;
export const ISSUES_REPO = 'arki-labs/arki';
export const DEMO_ISSUES_DIR = path.join('.release', 'demo-issues');
const GAPS_FILE = path.join('docs', 'lib-gaps.md');
const ISSUE_URL = /https:\/\/github\.com\/arki-labs\/arki\/issues\/\d+/;

/** One validated row of a `lib-gaps.md` table. */
export const gapRowSchema = z.object({
  /** Zero-based line in the file, for the write-back. */
  line: z.number().int().nonnegative(),
  number: z.number().int().positive(),
  /** `@arki/<x>` names found in the Package cell. `@arki/*` (all) names none. */
  packages: z.array(z.string().startsWith('@arki/')),
  gap: z.string().min(1),
  found: z.string(),
  status: z.string().min(1),
  open: z.boolean(),
  issueUrl: z.string().url().nullable(),
});
export type GapRow = z.infer<typeof gapRowSchema>;

/** The issue to create for one open row. */
export const issueDraftSchema = z.object({
  row: z.number().int().positive(),
  packages: z.array(z.string()),
  title: z.string().min(1),
  body: z.string().min(1),
  labels: z.array(z.string()).min(1),
  issueUrl: z.string().url().nullable(),
});
export type IssueDraft = z.infer<typeof issueDraftSchema>;

export const preparedFileSchema = z.object({ demo: z.string().min(1), items: z.array(issueDraftSchema) });

const summarySchema = z.object({ message: z.string(), demo: z.string().nullable(), openRows: z.number(), created: z.number(), file: z.string().nullable() });
export type DemoIssuesSummary = z.infer<typeof summarySchema>;
export type DemoIssuesEnvelope = ReleaseCommandEnvelope<IssueDraft, DemoIssuesSummary>;

/** Split a table line on pipes that are not `\|`. */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (char === '\\' && line.charAt(i + 1) === '|') {
      current += '\\|';
      i += 1;
    } else if (char === '|') {
      cells.push(current);
      current = '';
    } else current += char;
  }
  cells.push(current);
  return cells.slice(1, -1);
}

/** Bold and backticks around the first word do not change what a status says. */
function isOpenStatus(status: string): boolean {
  return /^[*_`\s]*open\b/i.test(status);
}

/**
 * Parse the rows of a `lib-gaps.md` table. A row starts with a number in its
 * first cell. A Status cell may hold bare pipes (row 2 of Drop Studio does),
 * so every cell after the fourth belongs to Status.
 */
export function parseLibGaps(markdown: string): GapRow[] {
  const rows: GapRow[] = [];
  markdown.split('\n').forEach((line, index) => {
    if (!line.startsWith('|')) return;
    const cells = splitCells(line);
    const [numberCell, pkgCell, gapCell, foundCell, ...statusCells] = cells;
    const number = numberCell?.trim();
    if (number === undefined || !/^\d+$/.test(number) || pkgCell === undefined || gapCell === undefined) return;
    const pkg = pkgCell.trim();
    const gap = gapCell.trim();
    const found = foundCell?.trim();
    const status = statusCells.join('|').trim();
    rows.push(
      gapRowSchema.parse({
        line: index,
        number: Number(number),
        packages: [...new Set(pkg.match(/@arki\/[\w-]+/g) ?? [])],
        gap: gap.replaceAll('\\|', '|'),
        found: found ?? '',
        status,
        open: isOpenStatus(status),
        issueUrl: ISSUE_URL.exec(status)?.[0] ?? null,
      }),
    );
  });
  return rows;
}

/** First sentence of the gap, without backticks, at most 90 characters. */
export function gapTitle(row: GapRow): string {
  const plain = row.gap.replaceAll('`', '').replaceAll('_', '');
  const sentence = plain.split(/\.\s/)[0]?.replace(/\.$/, '') ?? plain;
  return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
}

/** The issue to file for `row`, found by `demo`. */
export function issueDraft(demo: string, row: GapRow): IssueDraft {
  const where = row.packages.length > 0 ? row.packages.join(', ') : 'arki';
  return issueDraftSchema.parse({
    row: row.number,
    packages: row.packages,
    title: `${where}: ${gapTitle(row)}`,
    body: [
      row.gap,
      '',
      `Found by the \`${demo}\` demo (${row.found}). Row ${row.number} of its \`docs/lib-gaps.md\`.`,
      '',
      `Status in the log: ${row.status}`,
    ].join('\n'),
    labels: [`found-by:${demo}`, ...row.packages.map(name => `package:${name}`)],
    issueUrl: row.issueUrl,
  });
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Open gaps of every registered demo, with the demo that found them. A demo without the file adds none. */
export async function loadOpenDemoGaps(
  cwd: string,
  config: Pick<ReleaseConfig, 'demos'>,
): Promise<{ readonly demo: string; readonly row: GapRow }[]> {
  const out: { demo: string; row: GapRow }[] = [];
  for (const entry of config.demos ?? []) {
    const text = await readText(path.join(cwd, entry.path, GAPS_FILE));
    if (text === null) continue;
    for (const row of parseLibGaps(text)) if (row.open) out.push({ demo: entry.name, row });
  }
  return out;
}

function envelope(status: ReleaseCommandEnvelope['status'], summary: DemoIssuesSummary, items: IssueDraft[], errors: ReleaseError[]): DemoIssuesEnvelope {
  return createEnvelope<IssueDraft, DemoIssuesSummary>({ command: COMMAND, status, summary, items, errors });
}

function fail(code: string, message: string, remediation: string): ReleaseError {
  return { code, severity: 'error', message, remediation };
}

function failure(message: string, demo: string | null, error: ReleaseError): DemoIssuesEnvelope {
  return envelope('failure', { message, demo, openRows: 0, created: 0, file: null }, [], [error]);
}

export type RunDemoIssuesPrepareOptions = {
  readonly cwd: string;
  readonly config: Pick<ReleaseConfig, 'demos'>;
  readonly demo: string;
};

/** `--prepare`: parse the open rows and write `.release/demo-issues/<demo>.json`. */
export async function runDemoIssuesPrepare(options: RunDemoIssuesPrepareOptions): Promise<DemoIssuesEnvelope> {
  const { cwd, demo } = options;
  const entry = options.config.demos?.find(d => d.name === demo);
  if (entry === undefined) {
    const known = (options.config.demos ?? []).map(d => d.name).join(', ') || 'none';
    return failure(`Demo \`${demo}\` is not registered.`, demo, fail(DEMO_ISSUES_ERROR_CODES.unknownDemo, `Demo \`${demo}\` is not in arki.release.config.ts (${known}).`, 'Use a name from `demos`.'));
  }
  const gapsPath = path.join(cwd, entry.path, GAPS_FILE);
  const text = await readText(gapsPath);
  const rows = text === null ? [] : parseLibGaps(text);
  if (rows.length === 0) {
    return failure(`No gap rows in ${path.join(entry.path, GAPS_FILE)}.`, demo, fail(DEMO_ISSUES_ERROR_CODES.noGapsFile, `${gapsPath} is missing or has no numbered rows.`, 'Clone the demo repo and keep its gap log at docs/lib-gaps.md.'));
  }
  const items = rows.filter(row => row.open).map(row => issueDraft(demo, row));
  const file = path.join(DEMO_ISSUES_DIR, `${demo}.json`);
  await mkdir(path.join(cwd, DEMO_ISSUES_DIR), { recursive: true });
  await writeFile(path.join(cwd, file), `${JSON.stringify(preparedFileSchema.parse({ demo, items }), null, 2)}\n`);
  debug('prepared %d open rows of %d for %s', items.length, rows.length, demo);
  const filed = items.filter(item => item.issueUrl !== null).length;
  return envelope('success', { message: `${items.length} open rows (${filed} already have an issue). Wrote ${file}.`, demo, openRows: items.length, created: 0, file }, items, []);
}

export type RunDemoIssuesApplyOptions = RunDemoIssuesPrepareOptions & {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTty?: () => boolean;
  readonly exec?: ExecRunner;
};

/** `--apply`: founder only. Creates the missing issues and writes each link back into its row. */
export async function runDemoIssuesApply(options: RunDemoIssuesApplyOptions): Promise<DemoIssuesEnvelope> {
  const { cwd, demo } = options;
  const env = options.env ?? process.env;
  const isTty = options.isTty ?? (() => process.stdin.isTTY === true);
  const exec = options.exec ?? execRunner;
  const refuse = (error: ReleaseError): DemoIssuesEnvelope => failure(error.message, demo, error);
  if (env.CLAUDECODE !== undefined && env.CLAUDECODE !== '') {
    return refuse(fail(DEMO_ISSUES_ERROR_CODES.agentSession, '`demo issues --apply` creates GitHub issues, and agents never do that.', 'Run `bun release:arki demo issues --demo <name> --apply` yourself in a terminal. Agents run `--prepare` only.'));
  }
  if (!isTty()) {
    return refuse(fail(DEMO_ISSUES_ERROR_CODES.notTerminal, '`demo issues --apply` needs a terminal; stdin is not one.', 'Run it from an interactive shell.'));
  }
  const entry = options.config.demos?.find(d => d.name === demo);
  if (entry === undefined) {
    return refuse(fail(DEMO_ISSUES_ERROR_CODES.unknownDemo, `Demo \`${demo}\` is not in arki.release.config.ts.`, 'Use a name from `demos`.'));
  }
  const file = path.join(DEMO_ISSUES_DIR, `${demo}.json`);
  const raw = await readText(path.join(cwd, file));
  const prepared = preparedFileSchema.safeParse(raw === null ? undefined : safeJson(raw));
  if (!prepared.success || prepared.data.demo !== demo) {
    return refuse(fail(DEMO_ISSUES_ERROR_CODES.preparedUnreadable, `${file} is missing or invalid.`, `Run \`bun release:arki demo issues --demo ${demo} --prepare\` first.`));
  }
  const gapsPath = path.join(cwd, entry.path, GAPS_FILE);
  const errors: ReleaseError[] = [];
  const items: IssueDraft[] = [];
  let created = 0;
  for (const item of prepared.data.items) {
    if (item.issueUrl !== null) {
      items.push(item);
      continue;
    }
    // Re-read each time: the write-back of the previous row changed the file.
    const text = await readText(gapsPath);
    const row = text === null ? undefined : parseLibGaps(text).find(r => r.number === item.row);
    if (text === null || row === undefined || !row.open || row.issueUrl !== null) {
      errors.push(fail(DEMO_ISSUES_ERROR_CODES.rowMoved, `Row ${item.row} of ${GAPS_FILE} is gone, closed or already linked.`, `Run \`--prepare\` again.`));
      items.push(item);
      continue;
    }
    const args = ['issue', 'create', '--repo', ISSUES_REPO, '--title', item.title, '--body', item.body, ...item.labels.flatMap(label => ['--label', label])];
    const result = await exec('gh', args, { cwd });
    const url = ISSUE_URL.exec(result.stdout)?.[0];
    if (result.code !== 0 || url === undefined) {
      errors.push(fail(DEMO_ISSUES_ERROR_CODES.ghFailed, `\`gh issue create\` failed for row ${item.row}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`, 'Check `gh auth status` and that the labels exist on arki-labs/arki, then rerun; rows with a link are skipped.'));
      items.push(item);
      continue;
    }
    await writeFile(gapsPath, linkRow(text, row, url));
    created += 1;
    items.push({ ...item, issueUrl: url });
  }
  const ok = errors.length === 0;
  return envelope(ok ? 'success' : 'failure', { message: `Created ${created} issues; ${errors.length} problems.`, demo, openRows: items.length, created, file }, items, errors);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Put the issue link at the end of `row`'s Status cell, touching no other line. */
export function linkRow(markdown: string, row: GapRow, url: string): string {
  const lines = markdown.split('\n');
  const line = lines[row.line] ?? '';
  const id = url.slice(url.lastIndexOf('/') + 1);
  lines[row.line] = line.replace(/\s*\|\s*$/, ` [#${id}](${url}) |`);
  return lines.join('\n');
}
