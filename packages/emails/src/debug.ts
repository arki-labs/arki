import { createDebugLogger } from '@arki/logger/debug';

/**
 * Debug logger for email operations
 * Enable with: DEBUG=emails:send
 */
export const debugEmails = createDebugLogger('emails:send');

/**
 * Enable all email debug logs
 * Enable with: DEBUG=emails:*
 */
