/**
 * Reading `--input-file <path|->`: a file, or stdin for `-`. The one place
 * the package touches the file system.
 */
import { readFile } from 'node:fs/promises';

/** The text of `source`: stdin for `-`, else the file at that path. */
export async function readInputText(source: string, stdin: AsyncIterable<Uint8Array | string> | null): Promise<string> {
  if (source !== '-') return readFile(source, 'utf8');
  if (stdin === null) throw new TypeError('--input-file - needs stdin, and this run has none');
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stdin) text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
