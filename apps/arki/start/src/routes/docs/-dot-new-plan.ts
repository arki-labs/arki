/**
 * Small pure helpers of `/docs/dot-new`: the order of the templates, the commands that produce them, and how the
 * plan's numbers read.
 */

/**
 * The template `dot new` uses when no `--template` is given. `dot-new.json` does not say which one is the default, so
 * this is the one place that does. Source: `packages/dot/docs/cli.md` (the `stack` template is "default").
 */
export const DEFAULT_TEMPLATE = 'stack';

/** The templates with the default one first, the others in the order the plan lists them. */
export function defaultFirst<T extends { template: string }>(templates: readonly T[]): T[] {
  return templates.toSorted(
    (a, b) => Number(b.template === DEFAULT_TEMPLATE) - Number(a.template === DEFAULT_TEMPLATE),
  );
}

/** The command that writes `template` into `target`. */
export function newCommand(template: string, target: string): string {
  return template === DEFAULT_TEMPLATE ? `dot new ${target}` : `dot new ${target} --template ${template}`;
}

/** `48` becomes `48 B`, `2529` becomes `2.5 KB`. */
export function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** The release date in the plan's `createdAt`, as `21 Oct 2026`, always in UTC so server and browser agree. */
export function formatPlanDate(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** What the planned files of one template amount to: how many, how big, and how many already exist. */
export function summarizeOperations(operations: readonly { action: string; contentBytes: number }[]) {
  const created = operations.filter(operation => operation.action === 'create').length;
  return {
    files: operations.length,
    size: formatBytes(operations.reduce((sum, operation) => sum + operation.contentBytes, 0)),
    ownership:
      created === operations.length
        ? 'all new, all yours to edit'
        : `${operations.length - created} change existing files`,
  };
}

/** The "What it is" cell of a file: the plan's reason, or nothing when it is only the generic scaffold label. */
export function fileReason(reason: string): string {
  return reason.startsWith('Scaffold file:') ? '' : reason;
}
