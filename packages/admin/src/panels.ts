/**
 * @arki/admin/panels — answer shapes for the generic screens Foreman bundles.
 *
 * A panel names a renderer id (see {@link PANEL_RENDERER}); a read whose
 * `output` is one of these schemas gets a finished screen with no Foreman code
 * of its own. The app builds its read with the schema; Foreman parses the
 * answer with the same schema. One definition, both sides.
 *
 * - `arki.board`: a grid of number cards, each with a tone (ok, warn, bad, idle).
 * - `arki.rows`: a table with named, formatted columns. An action the panel
 *   lists becomes a button on every row that holds all of the action's
 *   required input keys; the row's values fill the input. An action with no
 *   required input becomes a button above the table.
 *
 * ```ts
 * const today = defineRead({
 *   id: 'shop.today', summary: 'How the shop is doing today', permission: 'shop:read',
 *   input: z.object({}), output: boardOutputSchema,
 *   load: async () => ({ cards: [{ key: 'orders', label: 'Orders', group: 'Sales', value: 12, format: 'count', tone: 'ok' }] }),
 * });
 * defineModule({ ..., reads: { today }, panels: [{ id: 'today', renderer: PANEL_RENDERER.board, read: 'today', actions: [] }] });
 * ```
 *
 * Isomorphic: no Node built-ins.
 */
import { z } from '@arki/contracts';

/** The renderer ids Foreman bundles for these shapes. Put one in a panel's `renderer`. */
export const PANEL_RENDERER = { board: 'arki.board', rows: 'arki.rows' } as const;

/** How a card or a row reads at a glance. Foreman draws a tone as a shape plus a word, never a colour alone. */
export const panelToneSchema = z.enum(['ok', 'warn', 'bad', 'idle']);

/** How a card's number is written: a count, US dollars, a percent (0–100) or a duration in milliseconds. */
export const boardFormatSchema = z.enum(['count', 'usd', 'percent', 'duration']);

/** One number card. `value: null` means the app could not measure it; Foreman shows a dash. */
export const boardCardSchema = z.object({
  /** Stable within the board; Foreman keys the card by it. */
  key: z.string().min(1),
  label: z.string().min(1),
  /** Cards that share a group sit together under that heading, in first-seen order. */
  group: z.string().min(1),
  value: z.number().nullable(),
  format: boardFormatSchema,
  tone: panelToneSchema,
  /** One short line under the number, such as "limit $5.00" or "3 in the last hour". */
  hint: z.string().optional(),
});

/** The answer of a read drawn by `arki.board`. */
export const boardOutputSchema = z.object({ cards: z.array(boardCardSchema) });

/**
 * How a cell is written:
 * `text` as is, `mono` for ids and emails, `count`/`usd`/`percent`/`duration` like a card,
 * `time` for an ISO timestamp (shown as an age), `tone` for a {@link panelToneSchema} value.
 */
export const rowsFormatSchema = z.enum(['text', 'mono', 'count', 'usd', 'percent', 'duration', 'time', 'tone']);

/** One column of an `arki.rows` table, in display order. */
export const rowsColumnSchema = z.object({
  /** The row key this column reads. */
  key: z.string().min(1),
  label: z.string().min(1),
  format: rowsFormatSchema,
});

/** One cell. Rows also carry keys no column shows, such as the id an action needs. */
export const rowsCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** The answer of a read drawn by `arki.rows`. */
export const rowsOutputSchema = z.object({
  columns: z.array(rowsColumnSchema).min(1),
  rows: z.array(z.record(z.string(), rowsCellSchema)),
  /** How many rows match in all; more than `rows.length` when the read returned a page. */
  total: z.number().int().nonnegative(),
  /** What to say when there are no rows, such as "No failed summaries." */
  empty: z.string().min(1),
});

export type PanelTone = z.output<typeof panelToneSchema>;
export type BoardCard = z.output<typeof boardCardSchema>;
export type BoardOutput = z.output<typeof boardOutputSchema>;
export type RowsColumn = z.output<typeof rowsColumnSchema>;
export type RowsCell = z.output<typeof rowsCellSchema>;
export type RowsOutput = z.output<typeof rowsOutputSchema>;
