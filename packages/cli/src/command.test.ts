/**
 * Type proofs for `defineCommand`, with no explicit type argument at any
 * call site: the point of the design is that a command's types are written
 * once, in its schema and its `run`, and inferred everywhere else.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

import type { AnyCommand, InputOf, OutputOf, ServicesOf } from './command.js';
import { defineCli } from './cli.js';
import { defineCommand } from './command.js';
import { group } from './tree.js';

const NotFound = defineFailure('item.not_found', { data: z.object({ id: z.string() }) });

describe('defineCommand types', () => {
  it('1. ctx.input is the schema output: a transform or a default changes it', () => {
    const cmd = defineCommand({
      describe: 'proof 1',
      input: z.object({ size: z.string().transform(Number), label: z.string().default('latest') }),
      run: ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<{ size: number; label: string }>();
        return input.size;
      },
    });
    expectTypeOf<InputOf<typeof cmd>>().toEqualTypeOf<{ size: number; label: string }>();
    expect(cmd.describe).toBe('proof 1');
  });

  it('2. a failure in run is removed from the output type', () => {
    const cmd = defineCommand({
      describe: 'proof 2',
      input: z.object({ id: z.string() }),
      run: ({ input }) => (input.id === '' ? NotFound({ id: input.id }) : { id: input.id, found: true as const }),
    });
    expectTypeOf<OutputOf<typeof cmd>>().toEqualTypeOf<{ id: string; found: true }>();
    expect(cmd.describe).toBe('proof 2');

    const asyncCmd = defineCommand({
      describe: 'proof 2, async',
      run: async () => {
        const rows = await Promise.resolve(42);
        return rows > 100 ? NotFound({ id: 'x' }) : rows;
      },
    });
    expectTypeOf<OutputOf<typeof asyncCmd>>().toEqualTypeOf<number>();
    expect(asyncCmd.describe).toBe('proof 2, async');
  });

  it('3. output schema and run must agree', () => {
    const ok = defineCommand({
      describe: 'proof 3',
      output: z.object({ embedded: z.number() }),
      run: () => ({ embedded: 200 }),
    });
    expectTypeOf<OutputOf<typeof ok>>().toEqualTypeOf<{ embedded: number }>();
    expect(ok.output).toBeDefined();

    defineCommand({
      describe: 'proof 3, mismatch',
      output: z.object({ embedded: z.number() }),
      // @ts-expect-error -- run returns a string where the output schema says number
      run: () => ({ embedded: 'many' }),
    });
  });

  it('4. args accepts only input keys', () => {
    defineCommand({
      describe: 'proof 4',
      input: z.object({ maxBatches: z.int().optional(), yes: z.boolean().default(false) }),
      args: ['maxBatches'],
      run: () => 0,
    });
    defineCommand({
      describe: 'proof 4, wrong key',
      input: z.object({ maxBatches: z.int().optional() }),
      // @ts-expect-error -- `batches` is not a key of the input
      args: ['batches'],
      run: () => 0,
    });
    defineCommand({
      describe: 'proof 4, no input',
      // @ts-expect-error -- a command without input has no positionals
      args: ['anything'],
      run: () => 0,
    });
  });

  describe('5. services come from the feature the entrypoint is attached to', () => {
    // The signature shape of `.entrypoints()` in packages/dot/src/define-feature.ts:858.
    type Entrypoint<S> = { readonly kind: string; readonly resolve: (services: S) => unknown };
    type BibleServices = { readonly embed: () => Promise<number>; readonly name: string };
    type Tree<S> = Readonly<Record<string, AnyCommand<S>>>;
    function feature<S>(services: S): {
      readonly services: S;
      entrypoints<const E extends readonly Entrypoint<S>[]>(...entrypoints: E): E;
      /** The candidate fix: `commands` bound to the feature, so its services are already known. */
      commands(tree: Tree<S>): Entrypoint<S>;
    } {
      return {
        services,
        entrypoints: (...entrypoints) => entrypoints,
        commands: tree => ({ kind: 'cli', resolve: () => tree }),
      };
    }
    function commands<S>(tree: Tree<S>): Entrypoint<S> {
      return { kind: 'cli', resolve: () => tree };
    }
    const services: BibleServices = { embed: () => Promise.resolve(1), name: 'bible' };
    const bible = feature(services);

    it('a feature-bound commands() types services and keeps a no-input command input empty', () => {
      const [entry] = bible.entrypoints(
        bible.commands({
          seed: defineCommand({
            describe: 'seed',
            input: z.object({ yes: z.boolean().default(false) }),
            run: ctx => {
              expectTypeOf(ctx.services).toEqualTypeOf<BibleServices>();
              return ctx.services.embed();
            },
          }),
          status: defineCommand({
            describe: 'a command without input in the same tree',
            run: ctx => {
              expectTypeOf(ctx.input).toEqualTypeOf<Readonly<Record<string, never>>>();
              return ctx.services.name;
            },
          }),
        }),
      );
      expect(entry.kind).toBe('cli');
    });

    it("a free commands() inside entrypoints() does NOT infer services (open: TS does not read E's constraint)", () => {
      bible.entrypoints(
        // @ts-expect-error -- services fall back to the default `{}`-like record, so the entrypoint does not fit
        commands({ seed: defineCommand({ describe: 'seed', run: ctx => ctx.services }) }),
      );
    });

    it('a free commands() with a concrete expected type does infer services', () => {
      const entry: Entrypoint<BibleServices> = commands({
        seed: defineCommand({ describe: 'seed', run: ctx => ctx.services.embed() }),
      });
      expect(entry.kind).toBe('cli');
    });

    it('a standalone command has empty services', () => {
      const standalone = defineCommand({
        describe: 'standalone',
        run: ctx => {
          expectTypeOf(ctx.services).toEqualTypeOf<Readonly<Record<string, never>>>();
          return Object.keys(ctx.services).length;
        },
      });
      expectTypeOf<ServicesOf<typeof standalone>>().toEqualTypeOf<Readonly<Record<string, never>>>();
      expectTypeOf<OutputOf<typeof standalone>>().toEqualTypeOf<number>();
      expect(standalone.describe).toBe('standalone');
    });
  });

  describe('slice 1 fields', () => {
    it('preview must succeed with what run succeeds with', () => {
      const cmd = defineCommand({
        describe: 'preview agrees',
        preview: () => ({ files: ['a'] }),
        run: async () => ({ files: await Promise.resolve(['a', 'b']) }),
      });
      expectTypeOf<OutputOf<typeof cmd>>().toEqualTypeOf<{ files: string[] }>();
      expect(cmd.describe).toBe('preview agrees');
      defineCommand({
        describe: 'preview disagrees',
        // @ts-expect-error -- preview returns a number where run succeeds with { files }
        preview: () => 1,
        run: () => ({ files: ['a'] }),
      });
    });

    it('render receives the success value, failures removed', () => {
      const cmd = defineCommand({
        describe: 'render',
        run: () => (Date.now() < 0 ? NotFound({ id: 'x' }) : { count: 1 }),
        render: (data, ui) => {
          expectTypeOf(data).toEqualTypeOf<{ count: number }>();
          ui.out(String(data.count));
        },
      });
      expect('render' in cmd).toBe(true);
    });

    it('ask names only input keys', () => {
      defineCommand({
        describe: 'ask',
        input: z.object({ name: z.string() }),
        ask: { name: 'Who?' },
        run: () => 0,
      });
      defineCommand({
        describe: 'ask, wrong key',
        input: z.object({ name: z.string() }),
        // @ts-expect-error -- `nam` is not a key of the input
        ask: { nam: 'Who?' },
        run: () => 0,
      });
    });

    it('a standalone command inside defineCli and group keeps its own input type', () => {
      const program = defineCli({
        name: 'tool',
        version: '1.0.0',
        commands: {
          users: group('Users', {
            add: defineCommand({
              describe: 'add',
              input: z.object({ name: z.string() }),
              run: ctx => {
                expectTypeOf(ctx.input).toEqualTypeOf<{ name: string }>();
                return ctx.input.name;
              },
            }),
            count: defineCommand({
              describe: 'count',
              run: ctx => {
                expectTypeOf(ctx.input).toEqualTypeOf<Readonly<Record<string, never>>>();
                // Inline in a tree, services come from the tree's context: unknown. A command in its own file has NoServices.
                expectTypeOf(ctx.services).toEqualTypeOf<unknown>();
                return 1;
              },
            }),
          }),
        },
      });
      expect(program.name).toBe('tool');
    });
  });
});
