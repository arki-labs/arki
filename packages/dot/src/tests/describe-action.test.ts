/**
 * `$describeAction`: a plugin completes its own action summaries once its
 * services exist. The static manifest keeps the declared text; the
 * post-boot manifest and `dot doctor` show the new one.
 */

import { orThrow, UnexpectedDefect } from '@arki/failure';
import { describe, expect, it } from 'vitest';

import { doctorStatus, renderDoctorText } from '../cli/render-doctor.js';
import { textUi } from '../cli/tests/text-ui.js';
import { defineApp } from '../define-app.js';
import { plugin } from '../plugin-contract.js';

const declared = { id: 'job.fire', binding: 'jobs', direction: 'in', summary: 'static text' } as const;

describe('$describeAction', () => {
  it('shows the new summary in the post-boot manifest and keeps the static one before boot', async () => {
    const owner = plugin({
      name: 'owner',
      actions: [declared],
      provides: {
        thing: ctx => {
          ctx.$describeAction('job.fire', { summary: 'full text' });
          return 1;
        },
      },
    });
    const configured = defineApp('t').use(owner).configure();
    const staticManifest = configured.manifest;
    const app = orThrow(await configured.boot());

    expect(staticManifest.actions[0]?.summary).toBe('static text');
    expect(app.manifest.actions[0]?.summary).toBe('full text');
    orThrow(await app.dispose());
  });

  it('lets an adapter amend actions in a binding it registered a projection for', async () => {
    const feature = plugin({ name: 'feat', actions: [declared] });
    const adapter = plugin({
      name: 'adapter',
      configure: ctx => {
        ctx.registerProjection({ format: 'jobs-table', binding: 'jobs', module: '@x/jobs' });
      },
      boot: ctx => {
        ctx.$describeAction('job.fire', { summary: 'adapter text' });
      },
    });
    const app = orThrow(await defineApp('t').use(feature).use(adapter).configure().boot());
    expect(app.manifest.actions.find(action => action.id === 'job.fire')?.summary).toBe('adapter text');
    orThrow(await app.dispose());
  });

  it('lets configure amend the static manifest, for actions of plugins mounted earlier', () => {
    const feature = plugin({ name: 'feat', actions: [declared] });
    const adapter = plugin({
      name: 'adapter',
      configure: ctx => {
        ctx.registerProjection({ format: 'jobs-table', binding: 'jobs', module: '@x/jobs' });
        ctx.describeAction('job.fire', { summary: 'configure text' });
      },
    });
    const configured = defineApp('t').use(feature).use(adapter).configure();
    expect(configured.manifest.actions[0]?.summary).toBe('configure text');
  });

  it('returns a defect when the plugin does not own the action', async () => {
    const owner = plugin({ name: 'owner', actions: [declared] });
    const intruder = plugin({
      name: 'intruder',
      boot: ctx => {
        ctx.$describeAction('job.fire', { summary: 'hijacked' });
      },
    });
    const configured = defineApp('t').use(owner).use(intruder).configure();
    const failure = await configured.boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: { message: expect.stringMatching(/cannot describe action "job\.fire"/) } });
  });

  it('shows the summary under the action in the doctor text', async () => {
    const owner = plugin({
      name: 'owner',
      actions: [declared],
      boot: ctx => {
        ctx.$describeAction('job.fire', { summary: 'full text' });
      },
    });
    const app = orThrow(await defineApp('t').use(owner).configure().boot());
    const { ui, text } = textUi();
    const diagnostics = app.diagnostics;
    renderDoctorText({ ...diagnostics, status: doctorStatus(diagnostics) }, ui);
    expect(text()).toContain('jobs:job.fire (plugin: owner)\n      ↳ full text');
    orThrow(await app.dispose());
  });
});
