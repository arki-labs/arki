/**
 * Timing Attacks During Login Explained:
 *
 * A timing attack exploits differences in the time it takes to process different inputs.
 * In a login scenario, a vulnerable system might:
 * 1. Quickly return an error if the provided email doesn't exist in the database.
 * 2. Take slightly longer if the email *does* exist because it then proceeds to hash the
 *    provided password and compare it against the stored hash.
 *
 * An attacker can measure these response time differences. By trying many potential emails,
 * they can infer which emails are registered in the system (user enumeration) based on
 * which requests take marginally longer.
 *
 * How this function helps mitigate:
 * By introducing a small, random delay *after* the database lookup (regardless of whether
 * the user was found) but *before* returning any response (success or failure),
 * we obscure the precise time difference between processing a non-existent user and an
 * existing user. This makes it significantly harder for an attacker to reliably perform
 * user enumeration based on timing analysis alone.
 */
export const preventTimingAttacks = async () => {
  await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 150));
};
