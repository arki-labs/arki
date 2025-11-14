/**
 * Standard execution context types for request/job classification
 * Used for logging, tracing, and context-specific behavior
 */
export enum ExecutionContext {
  /** tRPC API request */
  RPC = 'rpc',
  /** Queue job processing */
  QUEUE = 'queue',
  /** Event sourcing event handler */
  EVENT_SOURCING = 'event-sourcing',
  /** Scheduled cron job */
  CRON = 'cron',
  /** CLI command execution */
  CLI = 'cli',
  /** Background jobs */
  JOBS = 'jobs',
}

export type ExecutionContextType = `${ExecutionContext}`;
