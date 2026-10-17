/**
 * The command tree: commands, groups and lazy entries. Resolving a path
 * imports only the branch taken; an unknown name fails with the close names
 * at that level ("did you mean").
 */
import type { AnyCommand } from './command.js';
import { UnknownCommand } from './failures.js';

/** A command or group, or a loader that imports one: `() => import('./commands/seed.js')`. */
export type TreeEntry<TServices = unknown> =
  | AnyCommand<TServices>
  | Group<TServices>
  | (() => Promise<TreeNode<TServices> | { readonly default: TreeNode<TServices> }>);

/** Named entries at one level of the tree. */
export type CommandTree<TServices = unknown> = Readonly<Record<string, TreeEntry<TServices>>>;

/** A named level of the tree with its own help line. */
export type Group<TServices = unknown> = {
  readonly kind: 'group';
  readonly describe: string;
  readonly commands: CommandTree<TServices>;
};

/** What a loaded entry is: a command or a group. */
export type TreeNode<TServices = unknown> = AnyCommand<TServices> | Group<TServices>;

/**
 * A group of commands under one name.
 *
 * @example
 * const cli = defineCli({ name: 'app', version: '1.0.0', commands: {
 *   users: group('Manage users', { list: () => import('./commands/users/list.js') }),
 * } });
 */
export function group<TServices = unknown>(describe: string, commands: CommandTree<TServices>): Group<TServices> {
  return { kind: 'group', describe, commands };
}

export function isGroup<TServices>(node: TreeNode<TServices>): node is Group<TServices> {
  return 'kind' in node;
}

/** The node behind an entry, importing it when it is lazy. A module's `default` export is unwrapped. */
export async function load<TServices>(entry: TreeEntry<TServices>): Promise<TreeNode<TServices>> {
  if (typeof entry !== 'function') return entry;
  const loaded = await entry();
  return 'default' in loaded ? loaded.default : loaded;
}

/** One loaded child of a group, or the error its import threw. */
export type LoadedChild<TServices> =
  { readonly name: string; readonly node: TreeNode<TServices> } | { readonly name: string; readonly error: unknown };

/** Every child of a group, lazy ones imported (one level, never deeper). A child that fails to import is reported, not thrown. */
export async function loadChildren<TServices>(node: Group<TServices>): Promise<readonly LoadedChild<TServices>[]> {
  const entries = Object.entries(node.commands);
  const settled = await Promise.allSettled(entries.map(([, entry]) => load(entry)));
  return entries.map(([name], index): LoadedChild<TServices> => {
    const result = settled[index];
    if (result === undefined || result.status === 'rejected') return { name, error: result?.reason };
    return { name, node: result.value };
  });
}

/** Damerau–Levenshtein distance (optimal string alignment): a swap of two letters counts once. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const table: number[] = Array.from({ length: rows * columns }, () => 0);
  const at = (row: number, column: number): number => table[row * columns + column] ?? 0;
  for (let row = 0; row < rows; row += 1) table[row * columns] = row;
  for (let column = 0; column < columns; column += 1) table[column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      let best = Math.min(at(row - 1, column) + 1, at(row, column - 1) + 1, at(row - 1, column - 1) + cost);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        best = Math.min(best, at(row - 2, column - 2) + 1);
      }
      table[row * columns + column] = best;
    }
  }
  return at(rows - 1, columns - 1);
}

/** The names and aliases within distance 2 of `received`, closest first. */
export function suggestionsFor(received: string, names: readonly string[]): readonly string[] {
  return names
    .map(name => ({ name, distance: editDistance(received, name) }))
    .filter(entry => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .map(entry => entry.name);
}

/** Where a path resolved: the node, the names walked, and the argv left after them. */
export type Resolved<TServices> = {
  readonly node: TreeNode<TServices>;
  readonly path: readonly string[];
  readonly rest: readonly string[];
};

/** A command's aliases; a group has none. */
function aliasesOf<TServices>(node: TreeNode<TServices>): readonly string[] {
  return isGroup(node) ? [] : (node.aliases ?? []);
}

/** The child of `node` that has `alias` among its aliases. Loads the level's lazy children; one that fails to import is skipped. */
async function byAlias<TServices>(node: Group<TServices>, alias: string): Promise<TreeNode<TServices> | undefined> {
  const children: readonly LoadedChild<TServices>[] = await loadChildren(node);
  for (const child of children) {
    if ('node' in child && aliasesOf(child.node).includes(alias)) return child.node;
  }
  return undefined;
}

/**
 * Walk `argv` from `root`: each leading word names a child of the current
 * group. Only the branch taken is imported. A name that is neither a key nor
 * an eager child's alias loads that level's lazy children to check their
 * aliases, then fails with `cli.unknown_command`.
 */
export async function resolvePath<TServices>(
  root: Group<TServices>,
  argv: readonly string[],
): Promise<Resolved<TServices> | ReturnType<typeof UnknownCommand>> {
  let node: TreeNode<TServices> = root;
  const path: string[] = [];
  let index = 0;
  while (isGroup(node)) {
    const word = argv[index];
    if (word === undefined || word.startsWith('-')) break;
    const entry: TreeEntry<TServices> | undefined = node.commands[word];
    const next: TreeNode<TServices> | undefined = entry === undefined ? await byAlias(node, word) : await load(entry);
    if (next === undefined) {
      const children: readonly LoadedChild<TServices>[] = await loadChildren(node);
      const names = children.flatMap(child =>
        'node' in child ? [child.name, ...aliasesOf(child.node)] : [child.name],
      );
      return UnknownCommand({ received: [...path, word].join(' '), suggestions: [...suggestionsFor(word, names)] });
    }
    node = next;
    path.push(word);
    index += 1;
  }
  return { node, path, rest: argv.slice(index) };
}
