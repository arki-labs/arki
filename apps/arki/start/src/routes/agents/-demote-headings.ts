const fence = /^\s*(?:```|~~~)/;
const heading = /^(#{1,5}) /;

/**
 * Moves every ATX heading of a markdown file one level down (`#` → `##`), outside fenced code. A file shown inside a
 * page that already has its own `<h1>` must not bring a second one.
 */
export function demoteHeadings(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map(line => {
      if (fence.test(line)) inFence = !inFence;
      return inFence ? line : line.replace(heading, '#$1 ');
    })
    .join('\n');
}
