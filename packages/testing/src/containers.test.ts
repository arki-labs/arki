/**
 * Runs on real Docker. The containers started are recorded with a thin subclass so the test can ask
 * Docker whether each one is still running.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const started = vi.hoisted(() => ({ postgres: [] as { getId(): string; stop(): Promise<unknown> }[] }));

vi.mock('@testcontainers/postgresql', async importOriginal => {
  const original = await importOriginal<typeof import('@testcontainers/postgresql')>();
  class RecordingPostgres extends original.PostgreSqlContainer {
    override async start() {
      const container = await super.start();
      started.postgres.push(container);
      return container;
    }
  }
  return { ...original, PostgreSqlContainer: RecordingPostgres };
});

const {
  getGlobalPostgresConnectionString,
  getGlobalRedisConnectionString,
  setupGlobalTestContainers,
  teardownGlobalTestContainers,
} = await import('./containers.js');

const run = promisify(execFile);

/** True while Docker still has the container running. A removed container is not running. */
async function isRunning(id: string): Promise<boolean> {
  try {
    const { stdout } = await run('docker', ['inspect', '--format', '{{.State.Running}}', id]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.allSettled(started.postgres.splice(0).map(container => container.stop()));
  delete process.env.DB_URL;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
});

describe('shared containers', { timeout: 240_000 }, () => {
  it('stops Postgres and forgets its connection when Redis fails to start', async () => {
    await expect(setupGlobalTestContainers({ redisImage: 'redis:this-tag-does-not-exist-arki' })).rejects.toThrow();
    const [postgres] = started.postgres;
    expect(postgres).toBeDefined();
    expect(await isRunning(postgres!.getId())).toBe(false);
    expect(getGlobalPostgresConnectionString()).toBeUndefined();
    expect(getGlobalRedisConnectionString()).toBeUndefined();
    expect(process.env.DB_URL).toBeUndefined();
  });

  it('still stops Redis when the Postgres stop rejects, then reports the error', async () => {
    await setupGlobalTestContainers();
    const [postgres] = started.postgres;
    const realStop = postgres!.stop.bind(postgres);
    postgres!.stop = () => Promise.reject(new Error('postgres refused to stop'));
    await expect(teardownGlobalTestContainers()).rejects.toThrow('postgres refused to stop');
    expect(getGlobalRedisConnectionString()).toBeUndefined();
    const redisPort = process.env.REDIS_URL?.split(':').at(-1);
    const { stdout } = await run('docker', ['ps', '--filter', `publish=${redisPort}`, '--format', '{{.ID}}']);
    expect(stdout.trim()).toBe('');
    await realStop();
  });
});
