import validator from 'validator';

export const isBase64 = (value: string): boolean => {
  return validator.isBase64(value, { urlSafe: false });
};
