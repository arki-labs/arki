import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

test('LLM_PROVIDER defaults to local Ollama when validation runs, never a paid provider', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('CI', '');
  Reflect.deleteProperty(process.env, 'LLM_PROVIDER');
  vi.resetModules();
  const { env } = await import('./env');
  expect(env.LLM_PROVIDER).toBe('ollama');
});

test('LLM_PROVIDER accepts ollama explicitly', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('CI', '');
  vi.stubEnv('LLM_PROVIDER', 'ollama');
  vi.resetModules();
  const { env } = await import('./env');
  expect(env.LLM_PROVIDER).toBe('ollama');
});

test('with validation skipped (production), createLLMProvider still talks to Ollama, not OpenAI', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  Reflect.deleteProperty(process.env, 'LLM_PROVIDER');
  Reflect.deleteProperty(process.env, 'OLLAMA_BASE_URL');
  vi.resetModules();
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response('{}', { status: 500 }));
  });
  const { createLLMProvider } = await import('./ai-service/factory');
  const { z } = await import('@arki/contracts');
  await createLLMProvider({ model: 'x', maxRetries: 0 })
    .generateStructuredData('hi', z.object({ a: z.string() }))
    .catch(() => 'failed as expected');
  expect(urls[0]).toBe('http://127.0.0.1:11434/api/chat');
});
