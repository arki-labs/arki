// Standard-alphabet base64 with `=` padding, checked the way validator's
// `isBase64(value, { urlSafe: false })` checks it: the length is a multiple of 4,
// then the alphabet with at most two trailing `=`. Done inline so a call costs one
// length test and one precompiled regex, with no options object to merge.
const base64WithPadding = /^[a-z0-9+/]+={0,2}$/i;

export const isBase64 = (value: string): boolean => {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a string but received a ${String(value)}`);
  }
  if (value.length % 4 !== 0) return false;
  return value === '' || base64WithPadding.test(value);
};
