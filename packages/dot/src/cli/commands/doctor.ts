/** `dot doctor`: boot the app, report its diagnostics, dispose it. Exit 3 (`dot.doctor_failed`) on error issues. */
import { z } from 'zod';

import { defineCommand } from '@arki/cli';
import { isFailure } from '@arki/failure';

import { discoverApp } from '../discover.js';
import { runDoctor } from '../doctor.js';
import { renderDoctorText } from '../render-doctor.js';
import { isGraphData } from '../render-graph.js';

export default defineCommand({
  describe: 'Boot the app and print runtime diagnostics',
  input: z.object({
    app: z.string().optional().describe('App file (default: ./dot.config.ts, ./src/app.ts or ./app.ts)'),
    cwd: z.string().optional().describe('Working directory (default: current)'),
    graph: z.boolean().optional().describe('The plugin graph observed during boot, as Mermaid flowchart source'),
    observability: z.boolean().optional().describe('Also check that an OpenTelemetry SDK is registered'),
  }),
  effects: 'read',
  examples: [
    'dot doctor',
    'dot doctor --json | jq ".data.plugins[] | select(.status != \\"ok\\")"',
    'dot doctor --graph',
  ],
  async run({ input }) {
    const discovered = await discoverApp({ appPath: input.app, cwd: input.cwd });
    if (isFailure(discovered)) return discovered;
    return runDoctor(discovered.app, { graph: input.graph, observability: input.observability });
  },
  render(data, ui) {
    if (isGraphData(data)) ui.out(data.source);
    else renderDoctorText(data, ui);
  },
});
