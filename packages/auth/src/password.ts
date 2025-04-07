import bcrypt from 'bcrypt';

export const hashPassword = (password: string) => {
  // Increase salt rounds to 12 for better security
  return bcrypt.hash(password, 12);
};

export const comparePasswords = async (inputPassword: string, storedHash: string): Promise<boolean> => {
  if (!inputPassword || !storedHash) {
    return false;
  }
  try {
    return await bcrypt.compare(inputPassword, storedHash);
  } catch (error) {
    // Log the error for debugging, but return false for security
    console.error('Error comparing passwords:', error);
    return false;
  }
};
