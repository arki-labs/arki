/** What every fixture command's `run` imports lazily. Help never loads it. */
export function handle(path: string, input: unknown): { readonly path: string; readonly input: unknown } {
  return { path, input };
}
