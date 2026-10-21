/** Small pieces several `dot env` commands share. */

/** Only the `DOTENV_PRIVATE_KEY*` variables of this process: read files as written, unshadowed by the shell. */
export function privateKeysOnly(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('DOTENV_PRIVATE_KEY')));
}
