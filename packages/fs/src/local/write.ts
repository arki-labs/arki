/**
 * Pass-through of Node `appendFile`. It rejects with the raw Node system error (`ENOENT` for a missing
 * directory, `EACCES`, `ENOSPC` for a full disk); nothing is wrapped into a failure. For canonical outcomes
 * use `createLocalStorageAdapter` from `@arki/fs/storage/local-adapter`.
 */
export { appendFile as writeToTheFileEnd } from 'node:fs/promises';
