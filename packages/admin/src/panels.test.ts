import { describe, expect, expectTypeOf, it } from 'vitest';

import { z } from '@arki/contracts';

import type { BoardOutput, PanelTone, RowsCell, RowsOutput } from './panels.ts';
import { defineModule, defineRead, describeModule } from './module.ts';
import { boardOutputSchema, PANEL_RENDERER, rowsOutputSchema } from './panels.ts';

describe('panel shapes', () => {
  it('accepts a board whose card could not be measured, so an app never has to invent a zero', () => {
    const board: BoardOutput = {
      cards: [{ key: 'spend', label: 'AI spend', group: 'Summaries', value: null, format: 'usd', tone: 'idle' }],
    };
    expect(boardOutputSchema.parse(board)).toEqual(board);
  });

  it('refuses a tone Foreman cannot draw as a shape and a word', () => {
    const card = { key: 'k', label: 'K', group: 'G', value: 1, format: 'count', tone: 'red' };
    expect(boardOutputSchema.safeParse({ cards: [card] }).success).toBe(false);
  });

  it('keeps row keys no column shows, because row actions read their input from them', () => {
    const rows: RowsOutput = {
      columns: [{ key: 'email', label: 'Email', format: 'mono' }],
      rows: [{ email: 'ada@example.com', entryId: 'wl_1' }],
      total: 1,
      empty: 'Nobody is waiting.',
    };
    expect(rowsOutputSchema.parse(rows).rows[0]).toEqual({ email: 'ada@example.com', entryId: 'wl_1' });
  });

  it('refuses a table with no columns, which would render as an empty frame', () => {
    expect(rowsOutputSchema.safeParse({ columns: [], rows: [], total: 0, empty: 'None.' }).success).toBe(false);
  });

  it('refuses nested values in a cell, since a table cell cannot show them', () => {
    const rows = { columns: [{ key: 'a', label: 'A', format: 'text' }], rows: [{ a: { b: 1 } }], total: 1, empty: 'x' };
    expect(rowsOutputSchema.safeParse(rows).success).toBe(false);
  });

  it('infers the tone and cell unions from the schemas', () => {
    expectTypeOf<PanelTone>().toEqualTypeOf<'ok' | 'warn' | 'bad' | 'idle'>();
    expectTypeOf<RowsCell>().toEqualTypeOf<string | number | boolean | null>();
  });

  it('serves as a read output in a module panel that names a bundled renderer', async () => {
    const today = defineRead({
      id: 'shop.today',
      summary: 'Today',
      permission: 'shop:read',
      input: z.object({}),
      output: boardOutputSchema,
      load: () => Promise.resolve({ cards: [] }),
    });
    const module = defineModule({
      id: 'shop',
      version: '1.0.0',
      reads: { today },
      actions: {},
      panels: [{ id: 'today', renderer: PANEL_RENDERER.board, read: 'today', actions: [] }],
    });
    const description = await describeModule(module);
    expect(description.panels).toEqual([{ id: 'today', renderer: 'arki.board', read: 'today', actions: [] }]);
  });
});
