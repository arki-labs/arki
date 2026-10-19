import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ env: { ANTHROPIC_WORKSPACE_ID: undefined as string | undefined } }));

vi.mock('./env', () => ({ env: state.env }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: vi.fn(() => vi.fn()) }));

const { createAnthropic: createSdkAnthropic } = await import('@ai-sdk/anthropic');
const { createAnthropic } = await import('./anthropic');

// A user-scoped key (`sk-ant-usr…`) is rejected on every request unless it names a workspace, so a
// configured workspace must reach every provider @arki/ai builds, including per-key ones.
describe('createAnthropic', () => {
  beforeEach(() => {
    vi.mocked(createSdkAnthropic).mockClear();
  });

  test('sends the workspace header when ANTHROPIC_WORKSPACE_ID is set, keeping caller settings', () => {
    state.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_bench';

    createAnthropic({ apiKey: 'sk-ant-usr-test', headers: { 'x-trace': 'on' } });

    expect(createSdkAnthropic).toHaveBeenCalledWith({
      apiKey: 'sk-ant-usr-test',
      headers: { 'anthropic-workspace-id': 'wrkspc_bench', 'x-trace': 'on' },
    });
  });

  test('leaves the header off without a workspace, so workspace-scoped keys behave as before', () => {
    state.env.ANTHROPIC_WORKSPACE_ID = undefined;

    createAnthropic({ apiKey: 'sk-ant-api-test' });

    expect(createSdkAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant-api-test' });
  });
});
