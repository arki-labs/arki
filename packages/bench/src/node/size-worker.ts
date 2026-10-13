/**
 * Bundles one size case with Bun's bundler and prints the outputs as JSON.
 * Started by `createSizeRunner` as `bun size-worker.js '<request json>'`
 * when the host runtime (Node, Deno) has no bundler of its own.
 */
import { bundleWithBun, getBun, isBundleRequest } from './size.js';

const bun = getBun();
let request: unknown;
try {
  request = JSON.parse(process.argv[2] ?? '');
} catch {
  request = undefined;
}

if (bun === undefined) {
  process.stderr.write('The size worker must run under Bun.\n');
  process.exitCode = 1;
} else if (isBundleRequest(request)) {
  try {
    process.stdout.write(JSON.stringify(await bundleWithBun(bun, request)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write('The size worker expects one JSON argument: { entry, outdir, externals, root }.\n');
  process.exitCode = 1;
}
