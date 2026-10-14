/** CLI output. These bins talk to a terminal, so they write straight to stdout and stderr. */
export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function complain(line: string): void {
  process.stderr.write(`${line}\n`);
}
