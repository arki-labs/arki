/**
 * React components and hooks for AI functionality
 */

export * from './hooks/useAIChat';
export * from './hooks/useAIGeneration';
export * from './hooks/useRuntimeStream';
export * from './hooks/useSemanticSearch';
export * from './components/AIChat';
export * from './components/StreamingText';
export * from './components/SearchInterface';

// The pure reducer and types behind `useRuntimeStream`, so a browser app can fold or name runtime state
// without importing the root entry (which also carries server-only providers).
export {
  initialRuntimeUiState,
  runtimeEventReducer,
  type RuntimeToolCall,
  type RuntimeUiState,
  type RuntimeUiStatus,
} from '../runtime/ui-state';
export type { RuntimeEvent, RuntimeUsage, ToolFailure } from '../runtime/types';
