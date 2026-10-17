/**
 * The 50-command fixture as plain data: 10 groups of the same 5 commands.
 * The spike's lazy modules (`fifty/**`) and every competitor build the same
 * tree from these names, so each `--help` describes the same program.
 */
export type ShapeName = 'hello' | 'seed' | 'bench';

export const CATEGORIES = ['reference-fidelity', 'refusal', 'routing', 'historical', 'pastoral', 'fairness'] as const;

export const GROUPS = [
  'users',
  'posts',
  'media',
  'billing',
  'search',
  'jobs',
  'cache',
  'deploy',
  'bench',
  'admin',
] as const;

export const COMMANDS = [
  { name: 'list', shape: 'bench' },
  { name: 'show', shape: 'hello' },
  { name: 'create', shape: 'seed' },
  { name: 'sync', shape: 'seed' },
  { name: 'run', shape: 'bench' },
] as const satisfies readonly { readonly name: string; readonly shape: ShapeName }[];

export const VERSION = '0.0.0';

export function groupDescribe(group: string): string {
  return `Manage ${group}`;
}

export function commandDescribe(group: string, command: string): string {
  return `${command[0]?.toUpperCase() ?? ''}${command.slice(1)} ${group}`;
}
