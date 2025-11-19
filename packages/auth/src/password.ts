import bcrypt from 'bcrypt';

import { debugPassword } from './debug';

export const hashPassword = (password: string) => {
  debugPassword('[hashPassword] Hashing password with 12 salt rounds');
  // Increase salt rounds to 12 for better security
  return bcrypt.hash(password, 12);
};

export const comparePasswords = async (inputPassword: string, storedHash: string): Promise<boolean> => {
  if (!inputPassword || !storedHash) {
    debugPassword('[comparePasswords] Invalid input (hasPassword: %s, hasHash: %s)', !!inputPassword, !!storedHash);
    return false;
  }
  try {
    debugPassword('[comparePasswords] Comparing password with stored hash');
    const result = await bcrypt.compare(inputPassword, storedHash);
    debugPassword('[comparePasswords] Comparison result: %s', result ? 'match' : 'no match');
    return result;
  } catch (error) {
    debugPassword('[comparePasswords] Error comparing passwords: %s', error instanceof Error ? error.message : 'Unknown error');
    // Return false for security - don't expose internal errors
    return false;
  }
};
