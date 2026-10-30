/**
 * A benchmark run that could not finish for a reason the user can act on: a missing suite file, no
 * installed runtime, a worker that failed, a bundle that did not build. The CLI prints the message
 * and exits with code 1 instead of a stack trace. A bug in arki-bench itself stays a plain `Error`.
 */
export class BenchRunError extends Error {
  override name = 'BenchRunError';
}
