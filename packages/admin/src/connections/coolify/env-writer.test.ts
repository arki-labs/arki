/**
 * The Coolify env writer stores provisioning keys. A private key stored build-time ends up in
 * build arguments and logs, so the writer proves Coolify keeps a probe runtime-only before any
 * real value is sent, checks the stored flags after the write, and never lets a value reach an
 * error or a log line.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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
  is_shown_once: boolean;
};
type Mode = 'current' | 'ignores-buildtime-flag' | 'buildtime-for-app-key' | 'refuses';

const bulkBodySchema = z.object({
  data: z.array(
    z.object({ key: z.string(), value: z.string(), is_buildtime: z.boolean().optional(), is_shown_once: z.boolean() }),
  ),
});

/**
 * Behaves like Coolify 4.4.7: a new variable is build-time and runtime unless the request says
 * otherwise, and gets a preview copy without `is_shown_once`. `ignores-buildtime-flag` is a
 * version that drops the field. `GET /envs` returns values, as for a token that may read them.
 */
function fakeCoolify(mode: Mode) {
  const rows: Stored[] = [];
  const requests: { method: string; path: string; body: string }[] = [];
  let next = 0;
  const newUuid = () => `env-${String((next += 1))}`;
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
    if (method === 'GET') return Response.json(rows);
    if (method === 'DELETE') {
      const uuid = url.pathname.split('/').at(-1) ?? '';
      const index = rows.findIndex(row => row.uuid === uuid);
      if (index !== -1) rows.splice(index, 1);
      return Response.json({ message: 'Environment variable deleted.' });
    }
    const written = bulkBodySchema.parse(JSON.parse(body)).data.map(item => {
      const buildtime =
        mode === 'ignores-buildtime-flag' || (mode === 'buildtime-for-app-key' && item.key === 'FOREMAN_APP_KEY')
          ? true
          : (item.is_buildtime ?? true);
      const fields = { value: item.value, is_runtime: true, is_buildtime: buildtime };
      const existing = rows.find(row => row.key === item.key && !row.is_preview);
      if (existing !== undefined) {
        Object.assign(existing, fields, { is_shown_once: item.is_shown_once });
        return existing;
      }
      const row: Stored = {
        uuid: newUuid(),
        key: item.key,
        is_preview: false,
        is_shown_once: item.is_shown_once,
        ...fields,
      };
      rows.push(row, { ...row, uuid: newUuid(), is_preview: true, is_shown_once: false });
      return row;
    });
    return Response.json(written, { status: 201 });
  };
  const impl = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise.resolve(answer(input, init));
  const writer = createCoolifyEnvWriter({ baseUrl: BASE, token: 'write-token', fetch: vi.fn(impl) });
  return { writer, rows, requests };
}

const entries = [
  { key: 'FOREMAN_APP_ID', value: 'novelette', secret: false },
  { key: 'FOREMAN_APP_KEY', value: PRIVATE_KEY, secret: true },
];

describe('coolify env writer', () => {
  it('probes, then writes every entry runtime-only, literal, outside previews, private keys shown once', async () => {
    const { writer, rows, requests } = fakeCoolify('current');
    expect(await writer.write(APP, entries)).toEqual({ keys: ['FOREMAN_APP_ID', 'FOREMAN_APP_KEY'] });

    expect(requests[0]?.body).toContain(COOLIFY_RUNTIME_PROBE_KEY);
    const writes = requests.filter(request => request.method === 'PATCH');
    expect(writes).toHaveLength(2);
    // No real value goes out before the probe passed and was cleaned up.
    const realWrite = writes[1];
    if (realWrite === undefined) throw new Error('no real write');
    const firstReal = requests.indexOf(realWrite);
    expect(requests.slice(0, firstReal).some(request => request.body.includes(PRIVATE_KEY))).toBe(false);

    const sent = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).parse(JSON.parse(realWrite.body));
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
    expect(rows.find(row => row.key === 'FOREMAN_APP_KEY' && !row.is_preview)?.is_buildtime).toBe(false);
  });

  // A production identity key must not ride along into PR previews, unhidden.
  it('leaves no preview copy of a written key, and no probe at all', async () => {
    const { writer, rows } = fakeCoolify('current');
    await writer.write(APP, entries);
    expect(rows.map(row => `${row.key}${row.is_preview ? ' (preview)' : ''}`)).toEqual([
      'FOREMAN_APP_ID',
      'FOREMAN_APP_KEY',
    ]);
    expect(rows.find(row => row.key === 'FOREMAN_APP_KEY')?.is_shown_once).toBe(true);
  });

  it('removes preview copies left by an earlier write, leaving production variables', async () => {
    const { writer, rows } = fakeCoolify('current');
    await writer.write(APP, entries);
    const appKey = rows.find(row => row.key === 'FOREMAN_APP_KEY');
    if (appKey === undefined) throw new Error('no FOREMAN_APP_KEY row');
    rows.push({ ...appKey, uuid: 'env-old-preview', is_preview: true, is_shown_once: false });
    await writer.removePreviewCopies(APP, ['FOREMAN_APP_KEY', COOLIFY_RUNTIME_PROBE_KEY]);
    expect(rows.filter(row => row.is_preview)).toEqual([]);
    expect(rows.map(row => row.key)).toEqual(['FOREMAN_APP_ID', 'FOREMAN_APP_KEY']);
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
