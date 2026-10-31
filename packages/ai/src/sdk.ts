/**
 * Re-export of ai (Vercel AI SDK).
 * Import from '@arki/ai/sdk' instead of 'ai'.
 *
 * This is a raw pass-through: SDK calls made through it (`generateText`, `streamText`, ...) throw the
 * SDK's own errors (`APICallError`, `RetryError`, `NoObjectGeneratedError`, ...) and stream `error`
 * parts unchanged. `@arki/ai` maps none of them. For returned, typed failures use the providers
 * from `createLLMProvider` instead.
 */
export * from 'ai';
