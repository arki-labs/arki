/**
 * The process runners every release step shares. Each external effect
 * (git, npm, any other binary) goes through one of these injectable
 * callbacks, so tests never touch the network, git remotes or the real repo.
 *
 * A runner never throws on a non-zero exit: the exit code is data
 * (`git merge-base --is-ancestor` answers with it, `npm view` reports E404
 * with it).
 */

import { execFile } from 'node:child_process';

/** What one process run produced. */
export interface RunOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs any binary. */
export type ExecRunner = (command: string, args: readonly string[], options: { readonly cwd: string }) => Promise<RunOutput>;

/** Runs `git <args>`. */
export type GitRunner = (args: readonly string[], options: { readonly cwd: string }) => Promise<RunOutput>;

/** Runs `npm <args>` (`pack`, `view`, ...). */
export type NpmRunner = (args: readonly string[], options: { readonly cwd: string }) => Promise<RunOutput>;

// Large buffer: `npm pack --json` and `git diff --name-only` can print megabytes.
const MAX_BUFFER = 64 * 1024 * 1024;

/** Default {@link ExecRunner}: `execFile`, no shell. A binary that cannot start reports code 127. */
export const execRunner: ExecRunner = (command, args, options) =>
  new Promise(resolve => {
    execFile(command, [...args], { cwd: options.cwd, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const code = typeof error.code === 'number' ? error.code : 127;
      resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
    });
  });

export const defaultGitRunner: GitRunner = (args, options) => execRunner('git', args, options);

export const defaultNpmRunner: NpmRunner = (args, options) => execRunner('npm', args, options);
