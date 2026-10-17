/**
 * Help text from the tree and the flag specs. Group help imports each lazy
 * child once to read its `describe` (one level, never deeper); command help
 * reads the command's own input schema. Nothing here runs a command.
 */
import type { AnyCommand } from './command.js';
import type { FlagSpec } from './flags.js';
import type { Group } from './tree.js';
import { GLOBAL_FLAGS } from './flags.js';
import { isGroup, loadChildren } from './tree.js';

function columns(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`.trimEnd()).join('\n');
}

function valueLabel(spec: FlagSpec): string {
  return spec.choices === undefined ? spec.kind : spec.choices.join('|');
}

function flagLabel(spec: FlagSpec): string {
  const short = spec.short === undefined ? '' : `-${spec.short}, `;
  if (spec.key === 'color') return '--no-color';
  return `${short}--${spec.flag}${spec.kind === 'boolean' ? '' : ` <${valueLabel(spec)}>`}`;
}

function argumentLabel(spec: FlagSpec): string {
  const name = `<${spec.flag}>`;
  const shown = spec.variadic ? `${name}...` : name;
  return spec.required ? shown : `[${shown}]`;
}

function details(spec: FlagSpec): string {
  const notes: string[] = [];
  if (spec.position !== undefined) notes.push(valueLabel(spec));
  if (spec.array && spec.position === undefined) notes.push('repeatable');
  if (spec.required) notes.push('required');
  if (spec.defaultValue !== undefined) notes.push(`default: ${JSON.stringify(spec.defaultValue)}`);
  const note = notes.length === 0 ? '' : ` (${notes.join(', ')})`;
  return `${spec.description ?? ''}${note}`.trim();
}

function usageOf(name: string, path: readonly string[]): string {
  return [name, ...path].join(' ');
}

/** Help for a group: its children with their `describe`. Hidden commands are left out. */
export async function groupHelp<TServices>(
  name: string,
  path: readonly string[],
  node: Group<TServices>,
): Promise<string> {
  const children = await loadChildren(node);
  const rows = children.flatMap((child): (readonly [string, string])[] => {
    if ('error' in child) return [[child.name, '(failed to load)']];
    if (!isGroup(child.node) && child.node.hidden === true) return [];
    return [[child.name, child.node.describe]];
  });
  const head = node.describe === '' ? '' : `${node.describe}\n\n`;
  return (
    `${head}Usage: ${usageOf(name, path)} <command> [options]\n\n` +
    `Commands:\n${columns(rows)}\n\n` +
    `Run "${usageOf(name, [...path, '<command>'])} --help" for a command's options.\n`
  );
}

/** Help for a command: positionals, its options, the global options and examples. */
export function commandHelp<TServices>(
  name: string,
  path: readonly string[],
  command: AnyCommand<TServices>,
  specs: readonly FlagSpec[],
): string {
  const positionals = specs
    .filter(spec => spec.position !== undefined)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const options = specs.filter(spec => spec.position === undefined);
  const usage = [usageOf(name, path), ...positionals.map(spec => argumentLabel(spec)), '[options]'].join(' ');
  const sections = [`${command.describe}\n\nUsage: ${usage}`];
  if (positionals.length > 0) {
    sections.push(`Arguments:\n${columns(positionals.map(spec => [argumentLabel(spec), details(spec)]))}`);
  }
  if (options.length > 0) {
    sections.push(`Options:\n${columns(options.map(spec => [flagLabel(spec), details(spec)]))}`);
  }
  sections.push(`Global options:\n${columns(GLOBAL_FLAGS.map(spec => [flagLabel(spec), details(spec)]))}`);
  if (command.examples !== undefined && command.examples.length > 0) {
    sections.push(`Examples:\n${command.examples.map(example => `  ${example}`).join('\n')}`);
  }
  return `${sections.join('\n\n')}\n`;
}
