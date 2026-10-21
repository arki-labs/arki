/** `dot env`: encrypted env files (dotenvx 2.x format) for the app in the working directory. */
import { group } from '@arki/cli';

export default group('Encrypted env files: init, set, get, ls, check, run, rotate, keys', {
  init: () => import('./init.js'),
  set: () => import('./set.js'),
  get: () => import('./get.js'),
  ls: () => import('./ls.js'),
  check: () => import('./check.js'),
  encrypt: () => import('./encrypt.js'),
  decrypt: () => import('./decrypt.js'),
  rotate: () => import('./rotate.js'),
  run: () => import('./run.js'),
  explain: () => import('./explain.js'),
  keys: group('Back up and restore private keys in 1Password', {
    push: () => import('./keys-push.js'),
    pull: () => import('./keys-pull.js'),
  }),
});
