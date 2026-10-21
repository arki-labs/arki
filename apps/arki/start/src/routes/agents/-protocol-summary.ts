/**
 * The summary cards of `/agents`, read from `PROTOCOL.md` itself: its claim paragraph and the tables of §1, §3, §4,
 * §5 and §6. The page never holds a second copy of the protocol, so a change to the file shows up on the page. A
 * missing section or column throws, so a protocol edit that breaks the layout fails the build, not the page.
 */

type Table = { header: string[]; rows: string[][] };

/** The cells of one markdown table row, outer pipes removed. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replaceAll('\\|', '|'));
}

/** The lines of the `## ` section whose heading starts with `heading`, up to the next `## ` heading. */
function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.startsWith(`## ${heading}`));
  if (start === -1) throw new Error(`PROTOCOL.md has no section "## ${heading}"`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The first table of a section. */
function firstTable(markdown: string, heading: string): Table {
  const lines = sectionLines(markdown, heading);
  const first = lines.findIndex(line => line.startsWith('|'));
  if (first === -1) throw new Error(`PROTOCOL.md section "${heading}" has no table`);
  const block: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) break;
    block.push(line);
  }
  const [header = '', , ...rows] = block;
  return { header: splitRow(header), rows: rows.map(row => splitRow(row)) };
}

/** The table's rows as one record per row, keyed by column title. */
function records(table: Table): Record<string, string>[] {
  return table.rows.map(cells => Object.fromEntries(table.header.map((title, index) => [title, cells[index] ?? ''])));
}

function cell(row: Record<string, string>, column: string): string {
  const value = row[column];
  if (value === undefined) throw new Error(`PROTOCOL.md table has no column "${column}"`);
  return value;
}

/** The §6 rows the page shows, in order. The rest of that table stays in the full protocol. */
const DESIGN_ITEMS = [
  'Cells',
  'Repeats per cell',
  'Total runs',
  'Order',
  'Wall time cap',
  'Cost cap',
  'Tool-call cap',
  'Human feedback',
  'Total budget',
] as const;

export function summarizeProtocol(markdown: string) {
  const protocolId = /Protocol ID: `([^`]+)`/.exec(markdown)?.[1];
  if (protocolId === undefined) throw new Error('PROTOCOL.md names no Protocol ID');
  const claim = sectionLines(markdown, '1. ').find(line => line.trim() !== '');
  if (claim === undefined) throw new Error('PROTOCOL.md §1 has no claim paragraph');

  const designRows = records(firstTable(markdown, '6. '));
  const design = DESIGN_ITEMS.map(item => {
    const row = designRows.find(candidate => candidate['Item'] === item);
    if (row === undefined) throw new Error(`PROTOCOL.md §6 has no row "${item}"`);
    return { item, value: cell(row, 'Value') };
  });

  return {
    protocolId,
    claim,
    amendmentsNone: sectionLines(markdown, 'Amendments').join('\n').trim() === 'None.',
    claims: records(firstTable(markdown, '1. ')).map(row => ({ id: cell(row, 'Id'), text: cell(row, 'Condition') })),
    design,
    stacks: records(firstTable(markdown, '3. ')).map(row => ({ id: cell(row, 'Id'), name: cell(row, 'Stack') })),
    agents: records(firstTable(markdown, '4. ')).map(row => ({
      id: cell(row, 'Id'),
      harness: cell(row, 'Harness'),
      model: cell(row, 'Model ID'),
      verification: cell(row, 'Verification'),
    })),
    tasks: records(firstTable(markdown, '5. ')).map(row => ({ id: cell(row, 'Id'), text: cell(row, 'Task') })),
  };
}
