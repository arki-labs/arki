/**
 * One measuring process. `runFile` starts it as
 * `<runtime> worker.js '<request json>'`, one process after another.
 *
 * It prints progress events on stderr and exactly one result (or error) on
 * stdout, each line prefixed (see `PROTOCOL` in ./run.ts) so anything the
 * suite prints cannot be mistaken for them.
 *
 * Nothing is imported statically: under Node running this file from source,
 * the `.js` → `.ts` resolver (./ts-resolver) must be registered before the
 * host modules load, and the resolver module itself is loaded by its real
 * file name.
 */

const PROTOCOL_ERROR = '@arki/bench:error ';

type ResolverModule = { registerTypeScriptResolver: () => void };

function isResolverModule(value: unknown): value is ResolverModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'registerTypeScriptResolver' in value &&
    typeof value.registerTypeScriptResolver === 'function'
  );
}

/** The resolver next to this file: `.js` in dist, `.ts` when running from source. */
async function registerResolver(): Promise<void> {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const loaded: unknown = await import(new URL(`ts-resolver.${extension}`, import.meta.url).href);
  if (!isResolverModule(loaded)) throw new Error('ts-resolver does not export registerTypeScriptResolver.');
  loaded.registerTypeScriptResolver();
}

function describeError(error: unknown): { message: string; problems?: readonly string[] } {
  const message = error instanceof Error ? error.message : String(error);
  const problems =
    typeof error === 'object' && error !== null && 'problems' in error && Array.isArray(error.problems)
      ? error.problems.filter((item): item is string => typeof item === 'string')
      : undefined;
  return problems === undefined ? { message } : { message, problems };
}

function write(text: string): Promise<void> {
  return new Promise(resolve => process.stdout.write(text, () => resolve()));
}

async function main(): Promise<number> {
  try {
    await registerResolver();
    const host = await import('./run.js');
    const request: unknown = JSON.parse(process.argv[2] ?? '');
    if (!host.isWorkerRequest(request))
      throw new Error('The worker expects one JSON argument: { file, root, options }.');
    const result = await host.measureInThisProcess(request.file, request.root, {
      ...host.toRunOptions(request.options),
      onProgress: event => process.stderr.write(`${host.PROTOCOL.progress}${JSON.stringify(event)}\n`),
    });
    await write(`${host.PROTOCOL.result}${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    await write(`${PROTOCOL_ERROR}${JSON.stringify(describeError(error))}\n`);
    return 1;
  }
}

// Exit explicitly: a suite may leave timers or sockets open, and the host waits for this process to end.
process.exit(await main());
