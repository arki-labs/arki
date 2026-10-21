/**
 * AI Service utilities and providers
 */

// Common types and interfaces
export * from './types';

// Provider implementations
export * from './openai-service';
export * from './anthropic-service';
export * from './ollama-service';
export * from './groq-service';
export * from './google-service';
export * from './mistral-service';
export * from './openrouter-service';

// Provider router (rotation + fallback)
export * from './provider-router';

// LLM provider factory (provider-agnostic, driven by LLM_PROVIDER env var)
export {
  createLLMProvider,
  DEFAULT_ANTHROPIC_MODEL,
  resolveLlmModel,
  resolveLlmProvider,
  type LLMProviderConfig,
} from './factory';
export { LLM_PROVIDERS, type LLMProviderName } from './provider-names';

// "Is this provider usable?" before the first call
export { DEFAULT_PROBE_TIMEOUT_MS, probeLLMProvider, type ProbeOptions, type ReadyProvider } from './probe';

// Utilities
export * from './structured-generation';
export * from './prompts';
