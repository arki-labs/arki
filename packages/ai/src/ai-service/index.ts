/**
 * AI Service utilities and providers
 */

// Common types and interfaces
export * from './types.js';

// Provider implementations
export * from './openai-service.js';
export * from './anthropic-service.js';
export * from './ollama-service.js';
export * from './groq-service.js';
export * from './google-service.js';
export * from './mistral-service.js';
export * from './openrouter-service.js';

// Provider router (rotation + fallback)
export * from './provider-router.js';

// LLM provider factory (provider-agnostic, driven by LLM_PROVIDER env var)
export {
  createLLMProvider,
  DEFAULT_ANTHROPIC_MODEL,
  resolveLlmModel,
  resolveLlmProvider,
  type LLMProviderConfig,
} from './factory.js';
export { LLM_PROVIDERS, type LLMProviderName } from './provider-names.js';

// "Is this provider usable?" before the first call
export { DEFAULT_PROBE_TIMEOUT_MS, probeLLMProvider, type ProbeOptions, type ReadyProvider } from './probe.js';

// Utilities
export * from './structured-generation.js';
export * from './prompts.js';
