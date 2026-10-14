/** Status of a tool call lifecycle */
export type ToolCallStatus = 'pending' | 'running' | 'complete' | 'error';

/** Status of the AI agent in a conversation */
export type AgentStatusType = 'idle' | 'thinking' | 'executing' | 'waiting-for-input' | 'complete' | 'error';

/** Action a user can take on an approval card */
export type ApprovalAction = 'approve' | 'reject' | 'edit';

/** Result of a user's approval decision */
export type ApprovalResult = {
  action: ApprovalAction;
  feedback?: string;
}

/** A step in a multi-step agent flow */
export type AgentStep = {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'complete' | 'error';
  description?: string;
}

/** Tool call metadata for rendering */
export type ToolCallMeta = {
  toolName: string;
  status: ToolCallStatus;
  args?: Record<string, unknown>;
  result?: unknown;
  duration?: number;
  error?: string;
}
