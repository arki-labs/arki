import validator from 'validator';

export const isURL = (value: string): boolean => {
  return validator.isURL(value, {
    protocols: ['http', 'https'],
    require_tld: true,
    require_protocol: true,
    require_host: true,
    require_valid_protocol: true,
    allow_underscores: true,
    allow_trailing_dot: true,
  });
};
