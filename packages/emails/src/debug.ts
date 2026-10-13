import { getLogger } from '@arki/log';

/**
 * Debug logger for email operations
 * Enable with: DEBUG=emails:send
 */
export const debugEmails = getLogger('emails:send');

/**
 * Enable all email debug logs
 * Enable with: DEBUG=emails:*
 */
