/**
 * Pass-through of the `del` package. It rejects with the raw Node system error or the `del` error (for
 * example `EPERM` outside the working directory); nothing is wrapped into a failure. For canonical outcomes
 * use `createLocalStorageAdapter` from `@arki/fs/storage/local-adapter`.
 */
export * from 'del';
