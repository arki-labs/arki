'use client';

import * as React from 'react';

import type { RuntimeUiState } from '@arki/ai';
import { cn } from '@arki/ui/cn';

import type { AgentStatusType } from './types.js';
import { AgentStatus } from './agent-status.js';
import { RuntimeConversation, runtimeStatusToAgentStatus } from './runtime-conversation.js';

export type AgentPanelProps = Omit<React.ComponentProps<'section'>, 'title'> & {
  /** Display name of the agent (e.g. a candidate brand name). */
  name: string;
  /** The reduced runtime state for this agent (from `@arki/ai`'s `runtimeEventReducer`). */
  state: RuntimeUiState;
  /**
   * Override the status pill derived from `state.status` — e.g. force `waiting-for-input`
   * when the run is held at a pause-gate, which the runtime status alone can't express.
   */
  statusOverride?: AgentStatusType;
  /** Trailing header content (rank, score, badges). */
  headerAccessory?: React.ReactNode;
  /** Content rendered below the conversation (e.g. a verdict line or elimination reason). */
  footer?: React.ReactNode;
  /** Optional renderer for assistant text (markdown). Forwarded to `RuntimeConversation`. */
  renderText?: (text: string) => React.ReactNode;
};

/**
 * One agent's live panel: a titled card showing the agent's status pill, its tool calls, and
 * its text — the per-agent unit for any multi-agent surface (a comparison race, a council, a
 * fan-out). Pure presentation over a {@link RuntimeUiState}; the body is a status-suppressed
 * {@link RuntimeConversation} (the status lives in the header instead).
 *
 * @example
 * ```tsx
 * <AgentPanel name="Researcher" state={state} />
 * ```
 */
function AgentPanel({
  name,
  state,
  statusOverride,
  headerAccessory,
  footer,
  renderText,
  className,
  ...props
}: AgentPanelProps) {
  const hasRunningTool = state.toolCalls.some(tc => tc.status === 'running');
  const status = statusOverride ?? runtimeStatusToAgentStatus(state.status, hasRunningTool);

  return (
    <section
      data-slot="chat-agent-panel"
      className={cn('flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4', className)}
      {...props}
    >
      <header data-slot="chat-agent-panel-header" className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <AgentStatus status={status} />
        </div>
        {headerAccessory}
      </header>

      <RuntimeConversation state={state} renderText={renderText} hideStatus />

      {footer ? <footer data-slot="chat-agent-panel-footer">{footer}</footer> : null}
    </section>
  );
}

export { AgentPanel };
