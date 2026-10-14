'use client';

import * as React from 'react';

import type { RuntimeToolCall, RuntimeUiState, RuntimeUiStatus } from '@arki/ai';
import { cn } from '@arki/ui/cn';

import type { AgentStatusType, ToolCallStatus } from './types';
import { AgentStatus } from './agent-status';
import { MarkdownMessage } from './markdown-message';
import { ToolCall, ToolCallResult } from './tool-call';

/**
 * Renders an `@arki/ai` `RuntimeUiState` (the reduced agent-runtime event stream) using the
 * chat-ui styled primitives — the runtime-agnostic counterpart to the assistant-ui-backed
 * `Thread`. Pair with `@arki/ai`'s `useRuntimeStream` so any backend (AI SDK / Mastra / …)
 * renders through one component:
 *
 * ```tsx
 * const { state, run } = useRuntimeStream();
 * useEffect(() => { void run(fetchRuntimeEventStream('/api/assess')); }, []);
 * return <RuntimeConversation state={state} />;
 * ```
 */
/** Project a runtime status onto the chat-ui AgentStatus vocabulary. Exported so panels and
 *  other surfaces derive the same pill from a `RuntimeUiState`. */
export function runtimeStatusToAgentStatus(status: RuntimeUiStatus, hasRunningTool: boolean): AgentStatusType {
  switch (status) {
    case 'running': {
      return hasRunningTool ? 'executing' : 'thinking';
    }
    case 'done': {
      return 'complete';
    }
    case 'error': {
      return 'error';
    }
    default: {
      return 'idle';
    }
  }
}

function toToolStatus(status: RuntimeToolCall['status']): ToolCallStatus {
  switch (status) {
    case 'done': {
      return 'complete';
    }
    case 'error': {
      return 'error';
    }
    default: {
      return 'running';
    }
  }
}

export type RuntimeConversationProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  state: RuntimeUiState;
  /**
   * Optional renderer for the assistant text (e.g. `react-markdown`/`streamdown`).
   * Defaults to rendering the raw text — chat-ui leaves markdown rendering to the consumer.
   */
  renderText?: (text: string) => React.ReactNode;
  /** Hide the AgentStatus pill (e.g. when the surrounding surface shows its own status). */
  hideStatus?: boolean;
};

function RuntimeConversation({ state, renderText, hideStatus, className, ...props }: RuntimeConversationProps) {
  const hasRunningTool = state.toolCalls.some(tc => tc.status === 'running');

  return (
    <div data-slot="chat-runtime-conversation" className={cn('flex flex-col gap-3', className)} {...props}>
      {!hideStatus && <AgentStatus status={runtimeStatusToAgentStatus(state.status, hasRunningTool)} />}

      {state.toolCalls.map((toolCall, index) => (
        <ToolCall key={`${toolCall.tool}-${index}`} toolName={toolCall.tool} status={toToolStatus(toolCall.status)}>
          {toolCall.status === 'error' && toolCall.error ? (
            <ToolCallResult>
              <span className="text-destructive">{toolCall.error}</span>
            </ToolCallResult>
          ) : null}
        </ToolCall>
      ))}

      {state.text.length > 0 ? (
        <MarkdownMessage>{renderText ? renderText(state.text) : state.text}</MarkdownMessage>
      ) : null}

      {state.status === 'error' && state.error ? (
        <p data-slot="chat-runtime-error" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

export { RuntimeConversation };
