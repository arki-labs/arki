/**
 * Pass-through of the `glob` package. Unreadable directories are skipped and a missing directory yields no
 * matches; an invalid option rejects with the raw error. Nothing is wrapped into a failure.
 */
export { glob, globIterate, globStream } from 'glob';
