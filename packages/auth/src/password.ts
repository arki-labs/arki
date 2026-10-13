import bcrypt from 'bcrypt';

import { debugPassword } from './debug';

export const hashPassword = (password: string) => {
  debugPassword.debug('[hashPassword] Hashing password with 12 salt rounds');
  // Increase salt rounds to 12 for better security
  return bcrypt.hash(password, 12);
};

export const comparePasswords = async (inputPassword: string, storedHash: string): Promise<boolean> => {
  if (!inputPassword || !storedHash) {
    debugPassword.debug('[comparePasswords] Invalid input (hasPassword: {hasPassword}, hasHash: {hasHash})', {
      hasPassword: !!inputPassword,
      hasHash: !!storedHash,
    });
    return false;
  }
  try {
    debugPassword.debug('[comparePasswords] Comparing password with stored hash');
    const result = await bcrypt.compare(inputPassword, storedHash);
    debugPassword.debug('[comparePasswords] Comparison result: {result}', { result: result ? 'match' : 'no match' });
    return result;
  } catch (error) {
    debugPassword.debug('[comparePasswords] Error comparing passwords', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    // Return false for security - don't expose internal errors
    return false;
  }
};
