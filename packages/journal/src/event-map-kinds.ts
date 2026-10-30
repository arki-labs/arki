/**
 * The words of `dot explain --as event-map`'s graph, one `as const` list each: the types in
 * `projection.ts` and the schema in `event-map-schema.ts` both read them. No Zod here, so the
 * public `./projection` entry stays free of Zod types.
 */

/**
 * The node kinds of the graph. `command` is a `j.command` found by the entrypoint scan or run by a
 * workflow's command node. `entrypoint` is one procedure file the scan read.
 */
export const EVENT_MAP_NODE_KINDS = [
  'event',
  'entity',
  'projection',
  'effect',
  'tap',
  'workflow',
  'feature',
  'command',
  'entrypoint',
] as const;
/**
 * The edge kinds of the graph: `from` is the subject, `to` the object.
 * `writes`: command writes event. `folds`: entity folds event. `projects`: projection projects event.
 * `reacts`: effect, tap or workflow reacts to event (a workflow's `startOn`). `waits-for`: workflow waits for event.
 * `runs`: workflow runs command (a command node, or its `undo`). `calls`: entrypoint calls command. `owned-by`: handler owned by feature.
 */
export const EVENT_MAP_EDGE_KINDS = [
  'writes',
  'folds',
  'projects',
  'reacts',
  'waits-for',
  'runs',
  'calls',
  'owned-by',
] as const;
/** When a consumer of an event runs: inside the write's transaction, or after it commits. */
export const EVENT_MAP_TIMINGS = ['same-transaction', 'after-commit'] as const;
/** How often an after-commit consumer sees an event. */
export const EVENT_MAP_DELIVERIES = ['exactly-once', 'at-least-once', 'at-most-once'] as const;
/** Where the entrypoint scan looks when an app names no folder: the Dot feature folder convention (every `entrypoints` folder under `src/features`). */
export const EVENT_MAP_DEFAULT_ENTRYPOINT_ROOT = 'src/features';
