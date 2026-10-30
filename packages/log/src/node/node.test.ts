import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setImmediate as nextTick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOG_ERROR_CODES, LogError } from '../core/errors.js';
import { createLogging } from '../core/logging.js';
import { memorySink } from '../core/sinks.js';
import { asyncContext, file, fromEnv } from './index.js';

const directories: string[] = [];
function tempFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'arki-log-'));
  directories.push(directory);
  return path.join(directory, 'app.log');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('fromEnv', () => {
  it('turns LOG_LEVEL and DEBUG (with - exclusions) into settings', () => {
    expect(fromEnv({ LOG_LEVEL: 'debug', DEBUG: 'a:*,-a:b' })).toEqual({
      env: { level: 'debug', debug: { include: ['a'], exclude: ['a:b'] } },
    });
    expect(fromEnv({ DEBUG: '*', NO_COLOR: '1' })).toEqual({
      env: { debug: { include: [''], exclude: [] }, colors: false },
    });
    expect(fromEnv({})).toEqual({ env: {} });
  });

  it('lowers matching categories to debug, keeps excluded ones at their level, and LOG_LEVEL sets the root', () => {
    const logging = createLogging();
    const out = memorySink();
    logging.configure({
      ...fromEnv({ LOG_LEVEL: 'warn', DEBUG: 'arki:kv:*,-arki:kv:noisy' }),
      channels: { out },
      default: { level: 'info', channels: ['out'] },
    });
    logging.getLogger('arki:kv:redis').debug('kv debug');
    logging.getLogger('arki:kv:noisy:inner').debug('excluded');
    logging.getLogger('arki:kv:noisy').warn('excluded warn');
    logging.getLogger('other').info('below LOG_LEVEL');
    expect(out.records.map(record => record.template)).toEqual(['kv debug', 'excluded warn']);
  });

  it('rejects an unknown LOG_LEVEL with ARKI_LOG_E003', () => {
    let code: string | undefined;
    try {
      fromEnv({ LOG_LEVEL: 'verbose' });
    } catch (error) {
      code = error instanceof LogError ? error.code : undefined;
    }
    expect(code).toBe(LOG_ERROR_CODES.invalidLevel);
  });
});

describe('asyncContext', () => {
  it('keeps scoped fields across await and keeps two concurrent scopes apart', async () => {
    const logging = createLogging();
    const out = memorySink();
    logging.configure({ channels: { out }, default: { level: 'info', channels: ['out'] }, context: asyncContext() });
    const log = logging.getLogger('req');
    const handle = (requestId: string, delay: number): Promise<void> =>
      logging.withContext({ requestId }, async () => {
        log.info('start');
        await new Promise(resolve => setTimeout(resolve, delay));
        log.info('end');
      });
    await Promise.all([handle('a', 20), handle('b', 5)]);
    const seen = out.records.map(record => `${record.template}:${JSON.stringify(record.fields.requestId)}`);
    expect(seen).toEqual(['start:"a"', 'start:"b"', 'end:"b"', 'end:"a"']);
  });
});

describe('file sink', () => {
  it('writes JSON lines that parse, after the next tick, and nothing before it', async () => {
    const logPath = tempFile();
    const sink = file({ path: logPath });
    const logging = createLogging();
    const handle = logging.configure({ channels: { file: sink }, default: { level: 'info', channels: ['file'] } });
    const log = logging.getLogger('disk');
    log.info('first {n}', { n: 1 });
    log.warn('second', { error: new Error('bad') });
    expect(statSync(logPath).size).toBe(0);
    await nextTick();
    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(lines.map(text => JSON.parse(text) as unknown)).toMatchObject([
      { message: 'first 1', fields: { n: 1 } },
      { message: 'second', error: { message: 'bad' } },
    ]);
    await handle.close();
  });

  it('writes synchronously once 16 KiB are waiting', () => {
    const logPath = tempFile();
    const sink = file({ path: logPath });
    const logging = createLogging();
    logging.configure({ channels: { file: sink }, default: { level: 'info', channels: ['file'] } });
    const log = logging.getLogger('big');
    const text = 'x'.repeat(1024);
    for (let index = 0; index < 20; index++) log.info(text);
    expect(statSync(logPath).size).toBeGreaterThan(16 * 1024);
    void sink.close?.();
  });

  it('registers its exit hook when the factory is called and removes it on close', async () => {
    const before = process.listenerCount('exit');
    const sink = file({ path: tempFile() });
    expect(process.listenerCount('exit')).toBe(before + 1);
    await sink.close?.();
    expect(process.listenerCount('exit')).toBe(before);
  });
});

describe('file sink that cannot open its path', () => {
  it('throws a coded LogError with the cause, at configure time', () => {
    const missing = path.join(tempFile(), 'no-such-folder', 'app.log');
    expect(() => file({ path: missing })).toThrow(expect.objectContaining({ code: LOG_ERROR_CODES.fileOpenFailed, cause: expect.any(Error) }));
  });
});
