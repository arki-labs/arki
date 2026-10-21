/** `dot explain`: the app's static manifest, unit graph or a registered projection. Never boots the app. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { isFailure } from '@arki/failure';

import { discoverApp } from '../discover.js';
import { runExplain } from '../explain.js';
import { renderExplainText } from '../render-explain.js';
import { isGraphData } from '../render-graph.js';
import { isProjectionData } from '../render-projection.js';

export default defineCommand({
  describe: 'Print the static app graph (manifest); never boots the app',
  input: z
    .object({
      app: z.string().optional().describe('App file (default: ./dot.config.ts, ./src/app.ts or ./app.ts)'),
      cwd: z.string().optional().describe('Working directory (default: current)'),
      graph: z.boolean().optional().describe('The unit graph as Mermaid flowchart source, in boot order'),
      as: z.string().optional().describe('A registered projection format: openapi, asyncapi, help-text, ...'),
      module: z.string().optional().describe('Replace the projection module for this run (with --as)'),
    })
    .refine(input => input.as === undefined || input.graph !== true, {
      message: '--as and --graph cannot be used together',
      path: ['graph'],
    })
    .refine(input => input.module === undefined || input.as !== undefined, {
      message: '--module needs --as <format>',
      path: ['module'],
    }),
  effects: 'read',
  examples: [
    'dot explain',
    'dot explain --json | jq ".data.plugins[].name"',
    'dot explain --graph',
    'dot explain --as openapi',
  ],
  async run({ input }) {
    const discovered = await discoverApp({ appPath: input.app, cwd: input.cwd });
    if (isFailure(discovered)) return discovered;
    return runExplain(discovered.app, {
      graph: input.graph,
      as: input.as,
      module: input.module,
      appFilePath: discovered.filePath,
    });
  },
  render(data, ui) {
    if (isGraphData(data)) ui.out(data.source);
    else if (isProjectionData(data)) {
      ui.out(typeof data.document === 'string' ? data.document : JSON.stringify(data.document, null, 2));
    } else renderExplainText(data, ui);
  },
});
