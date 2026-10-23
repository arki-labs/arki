import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { SchemaInput } from '@arki/schema';

import type { CommandFailure } from '../errors.js';
import type { WorkflowDef } from './define.js';
import type { RunDetail } from './read.js';
import { need } from '../handlers.js';
import { j } from '../test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it. The callbacks never execute.
// A task is sugar for a one-step workflow, so its types must be the workflow builder's own: a task that typed its
// output, its needs or its read differently from `.step('run', fn).finish()` would drift from the runtime it desugars to.
type Mailer = { send(to: string): Promise<{ messageId: string }> };
const mailer: Mailer = { send: () => Promise.resolve({ messageId: 'm1' }) };
const workflowMeta = { actorId: 'system:workflow' };

const welcome = j.task(
  'mail.welcome',
  { version: 1, input: z.object({ to: z.string() }), needs: { mailer: need<Mailer>() }, retry: undefined },
  async ({ input, mailer: given, runId }) => {
    expectTypeOf(input).toEqualTypeOf<{ to: string }>();
    expectTypeOf(runId).toBeString();
    return given.send(input.to);
  },
);

const summarize = j.task(
  'docs.summarize',
  {
    version: 1,
    input: z.object({ docId: z.string() }),
    output: z.object({ summary: z.string() }),
    timeout: '10m',
    undo: ({ result }) => {
      // The undo sees what the body returned.
      expectTypeOf(result).toEqualTypeOf<{ summary: string }>();
    },
  },
  ({ input }) => ({ summary: input.docId }),
);

/** The same task written as the workflow it desugars to. */
const welcomeAsWorkflow = j
  .workflow('mail.welcome', { version: 1, input: z.object({ to: z.string() }), needs: { mailer: need<Mailer>() } })
  .step('run', async ({ input, mailer: given }) => given.send(input.to))
  .finish();

describe('j.task, as types', () => {
  it('infers the output from what the body returns, awaited', () => {
    expectTypeOf<NonNullable<typeof welcome.types>['output']>().toEqualTypeOf<{ messageId: string }>();
  });

  it('has the very type of the workflow it desugars to', () => {
    expectTypeOf(welcome).toEqualTypeOf(welcomeAsWorkflow);
  });

  it("takes the output schema's output as the output, and def.read reads it typed", () => {
    expectTypeOf<NonNullable<typeof summarize.types>['output']>().toEqualTypeOf<{ summary: string }>();
    expectTypeOf<Extract<Awaited<ReturnType<typeof summarize.read>>, { readonly steps: unknown }>>().toEqualTypeOf<
      RunDetail<{ docId: string }, { summary: string }, { readonly run?: unknown }>
    >();
  });

  it('refuses a body that does not return the output schema', () => {
    j.task(
      'docs.bad',
      { version: 1, input: z.object({}), output: z.object({ summary: z.string() }) },
      // @ts-expect-error the output schema says `summary: string`, and the body returns a number
      () => ({ summary: 1 }),
    );
  });

  it('types the needs into the body, and compose checks them', () => {
    j.task('mail.ping', { version: 1, input: z.object({}), needs: { mailer: need<Mailer>() } }, ({ mailer: given }) =>
      expectTypeOf(given).toEqualTypeOf<Mailer>(),
    );
    // @ts-expect-error a task without needs has no `mailer` in its context
    j.task('mail.none', { version: 1, input: z.object({}) }, ({ mailer: given }) => given);
    j.compose({ workflows: [welcome, summarize], workflowMeta, services: { mailer } });
    // @ts-expect-error -- `welcome` needs `mailer`, so `compose` without `services` must not compile
    j.compose({ workflows: [welcome], workflowMeta });
  });

  it('is a WorkflowDef: it goes wherever a workflow goes, such as a child of another workflow', () => {
    expectTypeOf(summarize).toExtend<WorkflowDef>();
    const _parent = j
      .workflow('docs.publish', { version: 1, input: z.object({ docId: z.string() }) })
      .child('summary', summarize, { input: ({ input }) => input })
      .step('post', ({ results }) => {
        // A child's result is the child's output.
        expectTypeOf(results.summary).toEqualTypeOf<{ summary: string }>();
        return results.summary.summary;
      })
      .finish();
    expectTypeOf<NonNullable<typeof _parent.types>['output']>().toBeString();
  });

  it('has start and startBatch, typed by the input schema', () => {
    expectTypeOf<SchemaInput<typeof summarize.start.input>['input']>().toEqualTypeOf<{ docId: string }>();
    expectTypeOf<SchemaInput<typeof summarize.startBatch.input>['items'][number]['input']>().toEqualTypeOf<{
      docId: string;
    }>();
    expectTypeOf<Awaited<ReturnType<typeof summarize.startBatch.handler>>>().toExtend<
      { readonly batchId: string } | CommandFailure
    >();
  });
});
