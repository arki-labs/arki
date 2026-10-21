/**
 * The providers `createLLMProvider` can build, written once. `LLM_PROVIDER`, the provider
 * config and the `ProviderUnavailable` failure all read this list. It imports nothing, so a
 * failure schema can use it without loading the environment.
 */
export const LLM_PROVIDERS = ['ollama', 'openai', 'anthropic', 'groq', 'google', 'mistral'] as const;

/** One of {@link LLM_PROVIDERS}. */
export type LLMProviderName = (typeof LLM_PROVIDERS)[number];
