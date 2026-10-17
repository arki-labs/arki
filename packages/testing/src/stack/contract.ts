/**
 * The provider contract: one suite every service runs. A service that passes it can be put in a
 * stack by anyone. It needs Docker, because the services it guards are real containers.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { Json, ServiceSpec } from './index.js';
import { RUN_LABEL } from '../services/labels.js';

const run = promisify(execFile);

/** Containers still alive (or stopped but not removed) that carry this run's label. */
export async function leftoverContainers(runId: string): Promise<readonly string[]> {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', `label=${RUN_LABEL}=${runId}`]);
  return stdout.split('\n').filter(line => line !== '');
}

export function newRunId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type ContractOptions<TRun extends Json, TWorker extends Json> = {
  readonly name: string;
  readonly make: () => ServiceSpec<TRun, TWorker>;
  /** A service of the same kind whose `start` fails after it has begun work. */
  readonly makeFailing?: () => ServiceSpec<TRun, TWorker>;
  /** Proves a slice works, for example by connecting. Runs on two slices at once. */
  readonly probe?: (worker: TWorker) => Promise<void>;
  /** Proves two slices do not see each other. */
  readonly apart?: (a: TWorker, b: TWorker) => Promise<void>;
};

export function describeServiceContract<TRun extends Json, TWorker extends Json>(
  options: ContractOptions<TRun, TWorker>,
): void {
  describe(`service contract: ${options.name}`, () => {
    it('hands over JSON values and leaves nothing behind after stop, even when stopped twice', async () => {
      const runId = newRunId();
      const spec = options.make();
      const started = await spec.start({ runId });
      try {
        // eslint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip IS the test: structuredClone would accept a Map or a Date
        expect(JSON.parse(JSON.stringify(started.value))).toEqual(started.value);
        if (spec.slice !== undefined) {
          const slice = await spec.slice(started.value, { runId, workerIndex: 0 });
          // eslint-disable-next-line unicorn/prefer-structured-clone -- see above
          expect(JSON.parse(JSON.stringify(slice.value))).toEqual(slice.value);
          await slice.stop();
          await slice.stop();
        }
      } finally {
        await started.stop();
        await started.stop();
      }
      expect(await leftoverContainers(runId)).toEqual([]);
    }, 120_000);

    it('gives two concurrent workers separate slices', async () => {
      const runId = newRunId();
      const spec = options.make();
      const started = await spec.start({ runId });
      try {
        if (spec.slice === undefined) return;
        const [a, b] = await Promise.all([
          spec.slice(started.value, { runId, workerIndex: 0 }),
          spec.slice(started.value, { runId, workerIndex: 1 }),
        ]);
        try {
          expect(a.value).not.toEqual(b.value);
          await Promise.all([options.probe?.(a.value), options.probe?.(b.value)]);
          await options.apart?.(a.value, b.value);
        } finally {
          await Promise.all([a.stop(), b.stop()]);
        }
      } finally {
        await started.stop();
      }
      expect(await leftoverContainers(runId)).toEqual([]);
    }, 120_000);

    const makeFailing = options.makeFailing;
    if (makeFailing !== undefined) {
      it('leaves no container when start fails', async () => {
        const runId = newRunId();
        await expect(makeFailing().start({ runId })).rejects.toThrow();
        expect(await leftoverContainers(runId)).toEqual([]);
      }, 120_000);
    }
  });
}
