/**
 * AI Markdown Rendering Utilities
 *
 * This module provides markdown rendering components optimized for AI chat interfaces.
 * It exports two approaches:
 *
 * 1. ReactMarkdown + remarkGfm - The standard, battle-tested approach
 * 2. Streamdown - Vercel's streaming-optimized markdown renderer
 *
 * @example Using ReactMarkdown (standard approach)
 * ```tsx
 * import { ReactMarkdown, remarkGfm } from '@arki/ai/md';
 *
 * <ReactMarkdown remarkPlugins={[remarkGfm]}>
 *   {message.content}
 * </ReactMarkdown>
 * ```
 *
 * @example Using Streamdown (optimized for AI streaming)
 * ```tsx
 * import { Streamdown } from '@arki/ai/md';
 *
 * <Streamdown mode="streaming">
 *   {message.content}
 * </Streamdown>
 * ```
 */

'use client';

// React Markdown - standard approach
export { default as ReactMarkdown } from 'react-markdown';
export type { Components as MarkdownComponents } from 'react-markdown';
export { default as remarkGfm } from 'remark-gfm';

// Streamdown - Vercel's streaming-optimized renderer
export {
  Streamdown,
  Block,
  StreamdownContext,
  parseMarkdownIntoBlocks,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type StreamdownProps,
  type StreamdownContextType,
  type ControlsConfig,
  type MermaidOptions,
  type MermaidErrorComponentProps,
} from 'streamdown';
