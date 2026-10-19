/**
 * `@ai-sdk/anthropic`, with workspace support. Import from '@arki/ai/anthropic' instead of
 * '@ai-sdk/anthropic'.
 */
import type { AnthropicProvider, AnthropicProviderSettings } from '@ai-sdk/anthropic';
import { createAnthropic as createSdkAnthropic } from '@ai-sdk/anthropic';

import { env } from './env';

export * from '@ai-sdk/anthropic';

/**
 * `createAnthropic` that also sends `anthropic-workspace-id` when `ANTHROPIC_WORKSPACE_ID` is set.
 * A user-scoped key (`sk-ant-usr…`) must name its workspace on every request; a workspace-scoped
 * key needs nothing, and the header is left off.
 */
export function createAnthropic(settings: AnthropicProviderSettings = {}): AnthropicProvider {
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID;
  if (!workspaceId) return createSdkAnthropic(settings);
  return createSdkAnthropic({ ...settings, headers: { 'anthropic-workspace-id': workspaceId, ...settings.headers } });
}

/** The default provider: `ANTHROPIC_API_KEY`, plus the workspace header when configured. */
export const anthropic = createAnthropic();
