import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEmailClient } from './create';

vi.mock('../debug', () => ({ debugEmails: { debug: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createEmailClient', () => {
  it('throws a clear error when no provider is configured', () => {
    expect(() => createEmailClient({ isDev: false })).toThrow(/configure at least one provider/);
  });

  it('never falls back to process.env: env keys alone do not configure a provider', () => {
    vi.stubEnv('RESEND_API_KEY', 're_from_env');
    vi.stubEnv('UNOSEND_API_KEY', 'un_from_env');
    expect(() => createEmailClient({ isDev: false })).toThrow(/configure at least one provider/);
  });

  it('rejects an empty API key instead of silently disabling the provider', () => {
    expect(() => createEmailClient({ isDev: false, resend: { apiKey: '' } })).toThrow(/resend/);
  });

  it('does not read NODE_ENV: delivery is live unless isDev is passed', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: 'un_1' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createEmailClient({ isDev: false, unosend: { apiKey: 'key' } });

    await client.send({ to: 'a@example.com', from: 'b@example.com', subject: 's', text: 't' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('isDev: true logs instead of delivering', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const client = createEmailClient({ isDev: true, unosend: { apiKey: 'key' } });

    const result = await client.send({ to: 'a@example.com', from: 'b@example.com', subject: 's', text: 't' });

    expect(result.error).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
