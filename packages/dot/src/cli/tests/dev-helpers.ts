/** Shared bits of the `dot dev` tests: a Ui that records stderr lines, a free port, a temp project. */
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Ui } from '@arki/cli';

export function recordingUi(): { readonly ui: Ui; readonly lines: string[] } {
  const lines: string[] = [];
  const ui: Ui = {
    out: line => {
      lines.push(line);
    },
    info: line => {
      lines.push(line);
    },
    warn: line => {
      lines.push(`warning: ${line}`);
    },
  };
  return { ui, lines };
}

/** A port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export function tempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Resolves once `check` is true; throws after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
