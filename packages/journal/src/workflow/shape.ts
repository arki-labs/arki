/**
 * The node manifest a run pins at start: names, kinds, order, and which nodes have an undo.
 * Stored in `workflow_runs.shape` so Foreman can draw a stranded run whose code is gone.
 * Plain JSON; the builder (step 2) produces it.
 */
export type WorkflowShape = {
  readonly nodes: readonly {
    readonly name: string;
    readonly kind: 'step' | 'waitFor' | 'eventWait' | 'sleep' | 'child' | 'map' | 'command' | 'parallel';
    readonly undo: boolean;
    /** A child node's choice when its parent cancels or compensates; only on `child` nodes. */
    readonly onCancel?: 'cancel' | 'detach';
    /** The signal a `waitFor` node waits for; only on `waitFor` nodes. */
    readonly signal?: string;
    /** The name of the command a `command` node runs; only on `command` nodes. */
    readonly command?: string;
    /** The name of the command that undoes a `command` node; only on one with an `undo`. */
    readonly undoCommand?: string;
    /** What an `eventWait` node waits for: each label with its entity kind and event types. Part of the shape hash. */
    readonly on?: readonly { readonly label: string; readonly entity: string; readonly events: readonly string[] }[];
    /** How a `parallel` node ends: when every branch completed, or when the first did. Part of the shape hash. */
    readonly wait?: 'all' | 'any';
    /** The branches of a `parallel` node, each with the nodes of its own definition. Part of the shape hash. */
    readonly branches?: readonly { readonly name: string; readonly shape: WorkflowShape }[];
  }[];
};
