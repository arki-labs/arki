import validator from 'validator';

// Built once: validator merges its defaults into this object on the first call
// (the same constant values every time), so later calls skip the allocation.
const urlOptions: validator.IsURLOptions = {
  protocols: ['http', 'https'],
  require_tld: true,
  require_protocol: true,
  require_host: true,
  require_valid_protocol: true,
  allow_underscores: true,
  allow_trailing_dot: true,
};

export const isURL = (value: string): boolean => {
  return validator.isURL(value, urlOptions);
};
