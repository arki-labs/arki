/**
 * `.local/dot/dev.json`: the file that says a `dot dev` runs in this project.
 *
 * The supervisor creates it at start with `{ pid, startedAt }` and removes it
 * on exit. A later console unit adds `console.url`; the supervisor polls
 * for it. The create is atomic: the content is written to a private temp
 * file first, then hard-linked to the final name, which fails when the name
 * exists. A reader therefore never sees a half-written file.
 */
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { getLogger } from '@arki/log';

import { DevAlreadyRunning } from './failures.js';

const debugState = getLogger('arki:dot:cli:dev');

/** Where the state file lives, relative to the project directory. */
export const DEV_STATE_PATH = '.local/dot/dev.json';

const devStateZod = z.object({
  pid: z.number().int(),
  startedAt: z.iso.datetime(),
  console: z.object({ url: z.url() }).optional(),
});

/** The content of `dev.json`. */
export type DevState = z.infer<typeof devStateZod>;

/** Parses `dev.json` (Standard Schema: no validator library in the public type). */
export const devStateSchema: StandardSchemaV1<unknown, DevState> = devStateZod;

/** The absolute path of the state file of a project. */
export function devStatePath(cwd: string): string {
  return path.resolve(cwd, DEV_STATE_PATH);
}

/** True when a process with this pid exists. EPERM means it exists but belongs to another user. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** The parsed state at `file`, or null when it is missing or not a valid state. */
export async function readDevState(file: string): Promise<DevState | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = devStateZod.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Link `temp` to `file`. False when `file` already exists. */
async function linkExclusive(temp: string, file: string): Promise<boolean> {
  try {
    await link(temp, file);
    return true;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false;
    throw error;
  }
}

/**
 * Move a stale state file aside and delete it. The rename is atomic, so two
 * supervisors that both saw a dead pid cannot both remove a fresh file: the
 * one that moved a live supervisor's file puts it back and reports it.
 */
async function reclaim(file: string, pid: number): Promise<number | null> {
  const aside = `${file}.stale-${String(pid)}`;
  try {
    await rename(file, aside);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  const moved = await readDevState(aside);
  if (moved !== null && moved.pid !== pid && isPidAlive(moved.pid)) {
    // Another supervisor claimed the file between our read and our rename.
    await linkExclusive(aside, file);
    await rm(aside, { force: true });
    return moved.pid;
  }
  await rm(aside, { force: true });
  debugState.debug('reclaimed a stale {file}', { file });
  return null;
}

/**
 * Create the state file for this supervisor. A file that names a live pid is
 * `dot.dev_already_running`; a dead pid or an unreadable file is reclaimed.
 */
export async function claimDevState(
  cwd: string,
  pid: number = process.pid,
  now: Date = new Date(),
): Promise<{ readonly file: string } | Failure> {
  const file = devStatePath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${String(pid)}.tmp`;
  const state: DevState = { pid, startedAt: now.toISOString() };
  await writeFile(temp, `${JSON.stringify(state)}\n`);
  try {
    // Two attempts: the first may find a stale file, which is reclaimed once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await linkExclusive(temp, file)) return { file };
      const existing = await readDevState(file);
      if (existing !== null && existing.pid !== pid && isPidAlive(existing.pid)) {
        return DevAlreadyRunning({ pid: existing.pid, statePath: file });
      }
      const winner = await reclaim(file, pid);
      if (winner !== null) return DevAlreadyRunning({ pid: winner, statePath: file });
    }
    const holder = await readDevState(file);
    return DevAlreadyRunning({ pid: holder?.pid ?? -1, statePath: file });
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Add `console.url` to the state file, but only while it still names `pid`. The rewrite goes through a private
 * temp file and a rename, so a reader never sees half a file.
 */
export async function publishConsoleUrl(file: string, url: string, pid: number = process.pid): Promise<void> {
  const state = await readDevState(file);
  if (state?.pid !== pid) return;
  const temp = `${file}.${String(pid)}.console.tmp`;
  const next: DevState = { ...state, console: { url } };
  await writeFile(temp, `${JSON.stringify(next)}\n`);
  await rename(temp, file);
}

/** Remove the state file, but only while it still names `pid`: never another supervisor's file. */
export async function releaseDevState(file: string, pid: number = process.pid): Promise<void> {
  const state = await readDevState(file);
  if (state?.pid !== pid) return;
  await rm(file, { force: true });
}
