/**
 * A deliberately expensive module, imported only by `bench run`'s handler.
 * If help or `--version` ever load it, the startup numbers show it.
 */
const table: number[] = [];
for (let index = 0; index < 2_000_000; index += 1) table.push(Math.sqrt(index));

export function heavyHandle(input: unknown): { readonly input: unknown; readonly rows: number } {
  return { input, rows: table.length };
}
