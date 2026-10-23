/**
 * The Coolify env writer stores provisioning keys. A private key stored build-time ends up in
 * build arguments and logs, so the writer proves Coolify keeps a probe runtime-only before any
 * real value is sent, checks the stored flags after the write, and never lets a value reach an
 * error or a log line.
 */
import { describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES, AdminError } from '../../errors';
import { COOLIFY_RUNTIME_PROBE_KEY, createCoolifyEnvWriter } from './index';

const BASE = 'https://coolify.example.invalid';
const APP = 'app00000example';
const PRIVATE_KEY = 'MC4CAQAwBQYDK2VwBCIEIsuper-secret-private-key-bytes';

type Stored = {
  uuid: string;
  key: string;
  value: string;
  is_runtime: boolean;
  is_buildtime: boolean;
  is_preview: boolean;
};
type Mode = 'current' | 'ignores-buildtime-flag' | 'buildtime-for-app-key' | 'refuses';

/**
 * Behaves like Coolify's bulk endpoint: a new variable is build-time and runtime unless the
 * request says otherwise. `ignores-buildtime-flag` is a version that drops the field.
 */
function fakeCoolify(mode: Mode) {
  const store = new Map<string, Stored>();
  const requests: { method: string; path: string; body: string }[] = [];
  let next = 0;
  const answer = (input: Parameters<typeof fetch>[0], init?: RequestInit): Response => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ method, path: url.pathname, body });
    if (mode === 'refuses') {
      return Response.json(
        { message: 'Validation failed.', errors: { value: [`"${PRIVATE_KEY}" is invalid`] } },
        { status: 422 },
      );
    }
    if (method === 'DELETE') {
      const uuid = url.pathname.split('/').at(-1) ?? '';
      for (const [key, row] of store) if (row.uuid === uuid) store.delete(key);
      return Response.json({ message: 'Environment variable deleted.' });
    }
    const { data } = JSON.parse(body) as {
      data: { key: string; value: string; is_buildtime?: boolean; is_preview: boolean }[];
    };
    const rows = data.map(item => {
      const buildtime =
        mode === 'ignores-buildtime-flag' || (mode === 'buildtime-for-app-key' && item.key === 'FOREMAN_APP_KEY')
          ? true
          : (item.is_buildtime ?? true);
      const row: Stored = {
        uuid: store.get(item.key)?.uuid ?? `env-${String((next += 1))}`,
        key: item.key,
        value: item.value,
        is_runtime: true,
        is_buildtime: buildtime,
        is_preview: item.is_preview,
      };
      store.set(item.key, row);
      return row;
    });
    // A token that may read sensitive data gets values back: the writer must drop them.
    return Response.json(rows, { status: 201 });
  };
  const impl = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(answer(input, init));
  const writer = createCoolifyEnvWriter({ baseUrl: BASE, token: 'write-token', fetch: vi.fn(impl) });
  return { writer, store, requests };
}

const entries = [
  { key: 'FOREMAN_APP_ID', value: 'novelette', secret: false },
  { key: 'FOREMAN_APP_KEY', value: PRIVATE_KEY, secret: true },
];

describe('coolify env writer', () => {
  it('probes, then writes every entry runtime-only, literal, outside previews, private keys shown once', async () => {
    const { writer, store, requests } = fakeCoolify('current');
    expect(await writer.write(APP, entries)).toEqual({ keys: ['FOREMAN_APP_ID', 'FOREMAN_APP_KEY'] });

    expect(requests.map(request => request.method)).toEqual(['PATCH', 'DELETE', 'PATCH']);
    expect(requests[0]?.body).toContain(COOLIFY_RUNTIME_PROBE_KEY);
    expect(store.has(COOLIFY_RUNTIME_PROBE_KEY)).toBe(false);

    const sent = JSON.parse(requests[2]?.body ?? '{}') as { data: Record<string, unknown>[] };
    expect(sent.data).toEqual([
      expect.objectContaining({
        key: 'FOREMAN_APP_ID',
        is_runtime: true,
        is_buildtime: false,
        is_preview: false,
        is_literal: true,
        is_shown_once: false,
      }),
      expect.objectContaining({
        key: 'FOREMAN_APP_KEY',
        is_runtime: true,
        is_buildtime: false,
        is_preview: false,
        is_literal: true,
        is_shown_once: true,
      }),
    ]);
    expect(store.get('FOREMAN_APP_KEY')?.is_buildtime).toBe(false);
  });

  it('sends no real value to a Coolify that would store it build-time', async () => {
    const { writer, requests } = fakeCoolify('ignores-buildtime-flag');
    const error = await writer.write(APP, entries).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(AdminError);
    expect((error as AdminError).code).toBe(ADMIN_ERROR_CODES.protocolUnsupported);
    expect(requests.some(request => request.body.includes(PRIVATE_KEY))).toBe(false);
  });

  it('fails, naming only the key, when a stored flag comes back wrong', async () => {
    const { writer } = fakeCoolify('buildtime-for-app-key');
    const error = await writer.write(APP, entries).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(AdminError);
    expect((error as AdminError).message).toMatch(/FOREMAN_APP_KEY as runtime-only/);
    expect((error as AdminError).message).not.toContain('FOREMAN_APP_ID');
  });

  it('keeps every value out of errors and logs, even when Coolify quotes it back in a 422', async () => {
    const spy = vi.spyOn(console, 'log').mockReturnValue();
    const failures = await Promise.all([
      fakeCoolify('refuses')
        .writer.write(APP, entries)
        .catch((error: unknown) => error),
      fakeCoolify('buildtime-for-app-key')
        .writer.write(APP, entries)
        .catch((error: unknown) => error),
      createCoolifyEnvWriter({
        baseUrl: BASE,
        token: 'write-token',
        fetch: () => Promise.reject(new Error(`boom ${PRIVATE_KEY}`)),
      })
        .write(APP, entries)
        .catch((error: unknown) => error),
    ]);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(AdminError);
      const error = failure as AdminError;
      expect(
        `${error.message} ${error.remediation} ${String(error.stack)} ${JSON.stringify(error.cause ?? null)}`,
      ).not.toContain('super-secret');
    }
    expect((failures[0] as AdminError).code).toBe(ADMIN_ERROR_CODES.invalidInput);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('super-secret');
    spy.mockRestore();
  });

  it('refuses bad entries before calling Coolify', async () => {
    const { writer, requests } = fakeCoolify('current');
    await expect(writer.write(APP, [{ key: 'lower-case', value: 'x', secret: false }])).rejects.toMatchObject({
      code: ADMIN_ERROR_CODES.invalidInput,
    });
    await expect(writer.write(APP, [])).rejects.toMatchObject({ code: ADMIN_ERROR_CODES.invalidInput });
    expect(requests).toEqual([]);
  });
});
