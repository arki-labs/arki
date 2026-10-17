/** `dot dev`: supervise the app in development. Exit 3 (`dot.dev_*`) when it cannot start. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';

import { runDev } from '../dev.js';

const port = z.number().int().min(1).max(65_535);

export default defineCommand({
  describe: 'Run the app in development: database, preflight, runner, file watch',
  input: z.object({
    app: z
      .string()
      .optional()
      .describe('App file (default: ./dot.config.ts, ./src/app.ts or ./app.ts); a `dev` export wins'),
    cwd: z.string().optional().describe('Project directory (default: current)'),
    db: z
      .enum(['auto', 'pglite', 'pg'])
      .default('auto')
      .describe('Database: auto is pg when DB_URL is set, else pglite'),
    allowRemoteDb: z
      .boolean()
      .default(false)
      .describe('Accept a database that is not local or a compose service: boot applies migrations to it'),
    port: port.default(3000).describe('App port, handed to the runner as PORT'),
    consolePort: port.default(4321).describe('Console port, handed to the runner as CONSOLE_PORT'),
    console: z.boolean().default(true).describe('Use --no-console to run without the dev console'),
    open: z.boolean().default(true).describe('Use --no-open to keep the browser closed'),
    once: z.boolean().default(false).describe('Stop after the preflight: no runner'),
    run: z.string().optional().describe('A shell command that serves the app, instead of vite dev or dot _serve'),
  }),
  examples: ['dot dev', 'dot dev --once --json', 'dot dev --db pg', 'dot dev --run "bun run src/server.ts"'],
  run: ({ input, ui, mode, signal }) => runDev({ ...input, ui, mode, signal }),
  render: () => {
    // Every event was printed as it happened.
  },
});
