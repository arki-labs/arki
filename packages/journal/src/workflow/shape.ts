/**
 * The node manifest a run pins at start: names, kinds, order, and which nodes have an undo.
 * Stored in `workflow_runs.shape` so Foreman can draw a stranded run whose code is gone.
 * Plain JSON; the builder (step 2) produces it.
 */
export type WorkflowShape = {
  readonly nodes: readonly {
    readonly name: string;
    readonly kind: 'step' | 'waitFor' | 'sleep' | 'child' | 'map';
    readonly undo: boolean;
    /** A child node's choice when its parent cancels or compensates; only on `child` nodes. */
    readonly onCancel?: 'cancel' | 'detach';
    /** The signal a `waitFor` node waits for; only on `waitFor` nodes. */
    readonly signal?: string;
  }[];
};
