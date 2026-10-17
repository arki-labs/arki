// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`. One command, a help run, a version run, a
// typo and a bad flag; the unit tests cover the details.

import { defineCli, defineCommand, ExitCode, group } from '../dist/index.js';

/** A minimal Standard Schema with JSON Schema, so the smoke test needs no validator library. */
const nameInput = {
  '~standard': {
    version: 1,
    vendor: 'smoke',
    validate: value =>
      typeof value === 'object' && value !== null && (value.name === undefined || typeof value.name === 'string')
        ? { value: { name: value.name ?? 'world' } }
        : { issues: [{ message: 'name must be a string', path: ['name'] }] },
    jsonSchema: {
      input: () => ({ type: 'object', properties: { name: { type: 'string', description: 'Who to greet' } } }),
      output: () => ({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }),
    },
  },
};

async function main() {
  const hello = defineCommand({
    describe: 'Greet someone',
    input: nameInput,
    run: ({ input }) => ({ greeting: `Hello, ${input.name}` }),
  });
  const program = defineCli({
    name: 'smoke',
    version: '9.9.9',
    commands: { hello, more: group('More commands', { hello }) },
  });
  const call = async argv => {
    let stdout = '';
    const exitCode = await program.main(argv, { stdout: text => (stdout += text), tty: false, env: {} });
    return { exitCode, stdout };
  };

  const ok = await call(['hello', '--name', 'x']);
  const nested = await call(['more', 'hello']);
  const help = await call(['--help']);
  const version = await call(['--version']);
  const typo = await call(['helo']);
  const badFlag = await call(['hello', '--nme', 'x']);

  const checks = [
    ['run exits 0', ok.exitCode, ExitCode.ok],
    ['envelope data', JSON.parse(ok.stdout).data.greeting, 'Hello, x'],
    ['envelope schema', JSON.parse(ok.stdout).meta.schema, 'arki.cli/1'],
    ['schema default applied', JSON.parse(nested.stdout).data.greeting, 'Hello, world'],
    ['help exits 0', help.exitCode, 0],
    ['help lists the command', help.stdout.includes('Greet someone'), true],
    ['version', version.stdout, '9.9.9\n'],
    ['unknown command exits 2', typo.exitCode, ExitCode.usage],
    ['did you mean', JSON.parse(typo.stdout).error.data.suggestions[0], 'hello'],
    ['unknown flag is invalid input', JSON.parse(badFlag.stdout).error.code, 'cli.invalid_input'],
  ];

  let failedChecks = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failedChecks++;
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const runtime = typeof Deno !== 'undefined' ? 'deno' : typeof Bun !== 'undefined' ? 'bun' : 'node';
  if (failedChecks > 0) {
    console.log(`${runtime}: ${failedChecks} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

main();
