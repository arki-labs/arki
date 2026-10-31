/**
 * React components and hooks for AI functionality
 */

export * from './hooks/useAIChat.js';
export * from './hooks/useAIGeneration.js';
export * from './hooks/useRuntimeStream.js';
export * from './hooks/useSemanticSearch.js';
export * from './components/AIChat.js';
export * from './components/StreamingText.js';
export * from './components/SearchInterface.js';

// The pure reducer and types behind `useRuntimeStream`, so a browser app can fold or name runtime state
// without importing the root entry (which also carries server-only providers).
export {
  initialRuntimeUiState,
  runtimeEventReducer,
  type RuntimeToolCall,
  type RuntimeUiState,
  type RuntimeUiStatus,
} from '../runtime/ui-state.js';
export type { RuntimeEvent, RuntimeFailure, RuntimeUsage, ToolFailure } from '../runtime/types.js';
