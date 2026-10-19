/**
 * @arki/admin/module — the isomorphic Foreman module contract.
 *
 * A package or feature describes what an operator may see and do as one
 * versioned module: Standard-Schema-typed **reads** (queries), **actions** (mutations
 * with a revision-carrying preview and a permit-guarded execute) and
 * **signals** (evidence it emits). One definition serves every surface —
 * Foreman UI forms, the app's HTTP dispatcher, agent tools and MCP tools —
 * through the JSON Schemas and `schemaHash`es {@link describeModule} returns,
 * and the DOT manifest through `toDotAction()`.
 *
 * Runs in Node, Bun, Deno and browsers: no Node built-ins, no peers. Hashing
 * uses Web Crypto.
 *
 * ```ts
 * export function queueModule(queue: QueueOperations) {
 *   return defineModule({
 *     id: '@arki/queue',
 *     version: '1.0.0',
 *     reads: {
 *       failedJobs: defineRead({
 *         id: 'queue.failedJobs', summary: 'Failed jobs, newest first', permission: 'queue:read',
 *         input: z.object({ limit: z.number().int().max(200).default(50) }),
 *         output: z.array(failedJobSchema),
 *         load: ({ limit }) => queue.failed({ limit }),
 *       }),
 *     },
 *     actions: {
 *       retryJob: defineAction({
 *         id: 'queue.retryJob', summary: 'Retry one failed job', permission: 'queue:write', risk: 'low',
 *         input: z.object({ jobId: z.string().min(1) }),
 *         previewOutput: z.object({ revision: z.string(), consequence: z.string() }),
 *         output: z.object({ requeued: z.boolean() }),
 *         preview: ({ jobId }) => queue.previewRetry(jobId),
 *         execute: ({ jobId }, _ctx, permit) => queue.retryFailed(jobId, { expectedRevision: permit.expectedRevision }),
 *       }),
 *     },
 *     panels: [{ id: 'failed-jobs', renderer: 'arki.queue.failed-jobs', read: 'failedJobs', actions: ['retryJob'] }],
 *   });
 * }
 * ```
 */
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { z } from '@arki/contracts';
import { InvalidInput, orThrow } from '@arki/failure';
import { formatIssues, hasJsonSchema, parseAsync } from '@arki/schema';

import type { JsonObject } from './json';
import { ADMIN_ERROR_CODES, AdminError } from './errors';
import { jsonObjectSchema, schemaHash } from './json';

export type { AdminErrorCode } from './errors';
export { ADMIN_ERROR_CODES, AdminError, isModuleError, moduleError } from './errors';
export type { ModuleError } from './errors';
export type { JsonObject, JsonValue } from './json';
export { canonicalJson, jsonObjectSchema, jsonValueSchema, schemaHash } from './json';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** `metaSchema` of every DOT action a module definition projects. */
export const MODULE_META_SCHEMA = '@arki/admin/module-meta@1';

/** Targets one action proposal may cover when the action does not say. */
export const DEFAULT_MAX_TARGETS = 1;

/** Hard cap on targets per proposal (bulk proposals freeze, canary and stop on failure). */
export const MAX_TARGETS_LIMIT = 5;

/** Read/action/signal/panel ids: dot-, dash- or underscore-separated segments, e.g. `queue.failedJobs`. */
const ID_PATTERN = /^[a-z][\dA-Za-z]*(?:[.\-_][\dA-Za-z]+)*$/;
/** `area:verb`, optionally deeper: `queue:read`, `payments:refund:write`. */
const PERMISSION_PATTERN = /^[a-z][\da-z-]*(?::[a-z][\da-z-]*)+$/;
/** Semantic version of the module contract. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
/** npm-style package name: `@arki/queue`, `billing`. */
const MODULE_ID_PATTERN = /^(?:@[\da-z~-][\w.~-]*\/)?[\da-z~-][\w.~-]*$/;
const SCHEMA_HASH_PATTERN = /^sha256:[\da-f]{64}$/;

const idSchema = z.string().regex(ID_PATTERN, 'Use dot-separated segments such as "queue.failedJobs".');
const permissionSchema = z.string().regex(PERMISSION_PATTERN, 'Use "area:verb" such as "queue:read".');
const summarySchema = z.string().min(1);

/** How dangerous a capability is. Reads are always `read`; actions are `low`, `medium` or `high`. */
export const riskClassSchema = z.enum(['read', 'low', 'medium', 'high']);
/** The risk classes an action may declare. */
export const actionRiskSchema = z.enum(['low', 'medium', 'high']);

export type RiskClass = z.output<typeof riskClassSchema>;
export type ActionRisk = z.output<typeof actionRiskSchema>;

/** `area:verb` permission an operator scope must cover, e.g. `queue:read`. */
export type Permission = `${string}:${string}`;

/**
 * Proof that an execution was approved. Built only by the dispatcher from a
 * verified execute envelope; request bodies can never supply it.
 */
export type Permit = {
  readonly executionId: string;
  /** The preview `revision` the approval pinned. Execute writes only if the resource still has it. */
  readonly expectedRevision: string;
  readonly approvedBy: string;
};

/** What every preview must carry: an app-computed revision of the resources it would touch. */
export type Revisioned = { revision: string };

/** A DOT manifest action (`@arki/dot` `ActionDeclaration`) with `binding: 'foreman'`. */
export type ForemanDotAction = {
  readonly id: string;
  readonly binding: 'foreman';
  readonly direction: 'in';
  readonly address: string;
  readonly summary: string;
  readonly metaSchema: typeof MODULE_META_SCHEMA;
  readonly meta: JsonObject;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What a module author writes for a read. */
export type ReadDef<TIn extends StandardSchemaV1, TOut extends StandardSchemaV1, TCtx> = {
  /** Globally unique, e.g. `queue.failedJobs`. */
  readonly id: string;
  readonly summary: string;
  readonly permission: Permission;
  readonly input: TIn;
  /**
   * Parsed on the way out. Whether keys the schema does not declare reach the client is the
   * schema's choice: zod and valibot objects drop them, an arktype object keeps them unless it
   * declares `'+': 'delete'`. A `load` that returns a whole row must use a schema that drops them.
   */
  readonly output: TOut;
  readonly load: (input: SchemaOutput<TIn>, ctx: TCtx) => Promise<SchemaInput<TOut>>;
};

type ReadBase = {
  readonly kind: 'read';
  readonly id: string;
  readonly summary: string;
  readonly permission: Permission;
  readonly risk: 'read';
  readonly jsonSchema: { readonly input: JsonObject; readonly output: JsonObject };
  /** The DOT manifest entry, so `dot explain` lists the read. */
  toDotAction(): ForemanDotAction;
};

/** A read built by {@link defineRead}. */
export type Read<TIn extends StandardSchemaV1, TOut extends StandardSchemaV1, TCtx> = ReadBase & {
  readonly input: TIn;
  readonly output: TOut;
  readonly load: (input: SchemaOutput<TIn>, ctx: TCtx) => Promise<SchemaInput<TOut>>;
  /** Validate raw input, load, validate output. What a dispatcher calls. */
  readonly run: (input: unknown, ctx: TCtx) => Promise<SchemaOutput<TOut>>;
};

/** Any read whose context accepts `TCtx` — what a module stores. */
export type AnyRead<TCtx> = ReadBase & {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly run: (input: unknown, ctx: TCtx) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** What a module author writes for an action. */
export type ActionDef<
  TIn extends StandardSchemaV1,
  TPreview extends StandardSchemaV1<unknown, Revisioned>,
  TOut extends StandardSchemaV1,
  TCtx,
> = {
  /** Globally unique, e.g. `queue.retryJob`. */
  readonly id: string;
  readonly summary: string;
  readonly permission: Permission;
  readonly risk: ActionRisk;
  /** Targets one proposal may cover. Defaults to {@link DEFAULT_MAX_TARGETS}, at most {@link MAX_TARGETS_LIMIT}. */
  readonly maxTargets?: number;
  readonly input: TIn;
  /** Must carry the app-computed `revision` the execute step is conditional on. */
  readonly previewOutput: TPreview;
  readonly output: TOut;
  readonly preview: (input: SchemaOutput<TIn>, ctx: TCtx) => Promise<SchemaInput<TPreview>>;
  /** Write only if the resource still has `permit.expectedRevision`. */
  readonly execute: (input: SchemaOutput<TIn>, ctx: TCtx, permit: Permit) => Promise<SchemaInput<TOut>>;
};

type ActionBase = {
  readonly kind: 'action';
  readonly id: string;
  readonly summary: string;
  readonly permission: Permission;
  readonly risk: ActionRisk;
  readonly maxTargets: number;
  readonly jsonSchema: {
    readonly input: JsonObject;
    readonly previewOutput: JsonObject;
    readonly output: JsonObject;
  };
  /** The DOT manifest entry, so `dot explain` lists the action. */
  toDotAction(): ForemanDotAction;
};

/** An action built by {@link defineAction}. */
export type Action<
  TIn extends StandardSchemaV1,
  TPreview extends StandardSchemaV1<unknown, Revisioned>,
  TOut extends StandardSchemaV1,
  TCtx,
> = ActionBase & {
  readonly input: TIn;
  readonly previewOutput: TPreview;
  readonly output: TOut;
  readonly preview: (input: SchemaOutput<TIn>, ctx: TCtx) => Promise<SchemaInput<TPreview>>;
  readonly execute: (input: SchemaOutput<TIn>, ctx: TCtx, permit: Permit) => Promise<SchemaInput<TOut>>;
  /** Validate raw input, preview, validate the preview. */
  readonly runPreview: (input: unknown, ctx: TCtx) => Promise<SchemaOutput<TPreview>>;
  /** Validate raw input, execute under the permit, validate the result. */
  readonly runExecute: (input: unknown, ctx: TCtx, permit: Permit) => Promise<SchemaOutput<TOut>>;
};

/** Any action whose context accepts `TCtx` — what a module stores. */
export type AnyAction<TCtx> = ActionBase & {
  readonly input: StandardSchemaV1;
  readonly previewOutput: StandardSchemaV1<unknown, Revisioned>;
  readonly output: StandardSchemaV1;
  readonly runPreview: (input: unknown, ctx: TCtx) => Promise<Revisioned>;
  readonly runExecute: (input: unknown, ctx: TCtx, permit: Permit) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Signals and panels
// ---------------------------------------------------------------------------

/** What a module author writes for a signal. */
export type SignalDef<TPayload extends StandardSchemaV1> = {
  /** e.g. `job.failed`. */
  readonly id: string;
  readonly summary: string;
  readonly payload: TPayload;
};

/** A signal built by {@link defineSignal}. */
export type Signal<TPayload extends StandardSchemaV1 = StandardSchemaV1> = SignalDef<TPayload> & {
  readonly kind: 'signal';
  readonly jsonSchema: { readonly payload: JsonObject };
};

/** A bundled screen: one read, the actions it offers, and the renderer id that draws it. */
export type PanelDef<TReadKey extends string = string, TActionKey extends string = string> = {
  readonly id: string;
  /** Picks a bundled UI component. A manifest can never ship code. */
  readonly renderer: string;
  readonly read: TReadKey;
  readonly actions: readonly TActionKey[];
};

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/** What a module author writes. Every read and action must accept the same context `TCtx`. */
export type ModuleDef<
  TCtx,
  TReads extends Record<string, AnyRead<TCtx>>,
  TActions extends Record<string, AnyAction<TCtx>>,
> = {
  /** Package or feature name, e.g. `@arki/queue`. */
  readonly id: string;
  /** Semver of this module's contract. */
  readonly version: string;
  readonly reads: TReads & Record<string, AnyRead<TCtx>>;
  readonly actions: TActions & Record<string, AnyAction<TCtx>>;
  readonly signals?: readonly Signal[];
  readonly panels?: readonly PanelDef<keyof TReads & string, keyof TActions & string>[];
};

/** A module built by {@link defineModule}. */
export type ForemanModule<
  TCtx,
  TReads extends Record<string, AnyRead<TCtx>> = Record<string, AnyRead<TCtx>>,
  TActions extends Record<string, AnyAction<TCtx>> = Record<string, AnyAction<TCtx>>,
> = {
  readonly kind: 'module';
  readonly id: string;
  readonly version: string;
  readonly reads: TReads;
  readonly actions: TActions;
  readonly signals: readonly Signal[];
  /** Key-checked by {@link defineModule}; stored with plain string keys so modules stay assignable to `ForemanModule<TCtx>`. */
  readonly panels: readonly PanelDef[];
  /** DOT manifest entries for every read and action — list them in a feature's `actions`. */
  toDotActions(): ForemanDotAction[];
};

/** Any module, whatever its context. Enough to describe it; a dispatcher needs the context type. */
export type AnyForemanModule = ForemanModule<never>;

// ---------------------------------------------------------------------------
// Wire description (JSON Schemas + hashes)
// ---------------------------------------------------------------------------

const schemaHashSchema = z.string().regex(SCHEMA_HASH_PATTERN);

/** One read as an app's manifest reports it. */
export const readDescriptionSchema = z.object({
  kind: z.literal('read'),
  /** Key in the module's `reads` record; panels refer to it. */
  key: z.string().min(1),
  id: idSchema,
  summary: summarySchema,
  permission: permissionSchema,
  risk: z.literal('read'),
  input: jsonObjectSchema,
  output: jsonObjectSchema,
  schemaHash: schemaHashSchema,
});

/** One action as an app's manifest reports it. */
export const actionDescriptionSchema = z.object({
  kind: z.literal('action'),
  key: z.string().min(1),
  id: idSchema,
  summary: summarySchema,
  permission: permissionSchema,
  risk: actionRiskSchema,
  maxTargets: z.number().int().min(1).max(MAX_TARGETS_LIMIT),
  input: jsonObjectSchema,
  previewOutput: jsonObjectSchema,
  output: jsonObjectSchema,
  schemaHash: schemaHashSchema,
});

/** One signal as an app's manifest reports it. */
export const signalDescriptionSchema = z.object({
  kind: z.literal('signal'),
  id: idSchema,
  summary: summarySchema,
  payload: jsonObjectSchema,
  schemaHash: schemaHashSchema,
});

/** One panel as an app's manifest reports it. */
export const panelDescriptionSchema = z.object({
  id: idSchema,
  renderer: idSchema,
  read: z.string().min(1),
  actions: z.array(z.string().min(1)),
});

/**
 * A whole module as an app's manifest reports it. Foreman parses what an app
 * sends with this schema — the wire is untrusted.
 */
export const moduleDescriptionSchema = z.object({
  id: z.string().regex(MODULE_ID_PATTERN),
  version: z.string().regex(SEMVER_PATTERN),
  reads: z.array(readDescriptionSchema),
  actions: z.array(actionDescriptionSchema),
  signals: z.array(signalDescriptionSchema),
  panels: z.array(panelDescriptionSchema),
});

export type ReadDescription = z.output<typeof readDescriptionSchema>;
export type ActionDescription = z.output<typeof actionDescriptionSchema>;
export type SignalDescription = z.output<typeof signalDescriptionSchema>;
export type PanelDescription = z.output<typeof panelDescriptionSchema>;
export type ModuleDescription = z.output<typeof moduleDescriptionSchema>;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const readMetaSchema = z.object({ id: idSchema, summary: summarySchema, permission: permissionSchema });
const actionMetaSchema = readMetaSchema.extend({
  risk: actionRiskSchema,
  maxTargets: z.number().int().min(1).max(MAX_TARGETS_LIMIT),
});
const signalMetaSchema = z.object({ id: idSchema, summary: summarySchema });
const moduleMetaSchema = z.object({
  id: z.string().regex(MODULE_ID_PATTERN, 'Use a package-style name such as "@arki/queue".'),
  version: z.string().regex(SEMVER_PATTERN, 'Use a semantic version such as "1.0.0".'),
});

/** Define a read. The context type is taken from `load`'s second parameter (`unknown` when unused). */
export function defineRead<TIn extends StandardSchemaV1, TOut extends StandardSchemaV1, TCtx = unknown>(
  def: ReadDef<TIn, TOut, TCtx>,
): Read<TIn, TOut, TCtx> {
  assertDefinition(readMetaSchema, def, `Read "${def.id}"`);
  const jsonSchema = {
    input: toJsonSchema(def.input, 'input', def.id, 'input'),
    output: toJsonSchema(def.output, 'output', def.id, 'output'),
  };
  return {
    kind: 'read',
    id: def.id,
    summary: def.summary,
    permission: def.permission,
    risk: 'read',
    input: def.input,
    output: def.output,
    load: def.load,
    jsonSchema,
    run: async (raw, ctx) => {
      const input = await parseInput(def.input, raw, def.id);
      return parseOutput(def.output, await def.load(input, ctx), def.id, 'load');
    },
    toDotAction: () => ({
      id: def.id,
      binding: 'foreman',
      direction: 'in',
      address: `read ${def.id}`,
      summary: def.summary,
      metaSchema: MODULE_META_SCHEMA,
      meta: { kind: 'read', permission: def.permission, risk: 'read', ...jsonSchema },
    }),
  };
}

/** Define an action. The preview schema must output a `revision` string; execute receives the approved {@link Permit}. */
export function defineAction<
  TIn extends StandardSchemaV1,
  TPreview extends StandardSchemaV1<unknown, Revisioned>,
  TOut extends StandardSchemaV1,
  TCtx = unknown,
>(def: ActionDef<TIn, TPreview, TOut, TCtx>): Action<TIn, TPreview, TOut, TCtx> {
  const maxTargets = def.maxTargets ?? DEFAULT_MAX_TARGETS;
  assertDefinition(actionMetaSchema, { ...def, maxTargets }, `Action "${def.id}"`);
  const jsonSchema = {
    input: toJsonSchema(def.input, 'input', def.id, 'input'),
    previewOutput: toJsonSchema(def.previewOutput, 'output', def.id, 'previewOutput'),
    output: toJsonSchema(def.output, 'output', def.id, 'output'),
  };
  return {
    kind: 'action',
    id: def.id,
    summary: def.summary,
    permission: def.permission,
    risk: def.risk,
    maxTargets,
    input: def.input,
    previewOutput: def.previewOutput,
    output: def.output,
    preview: def.preview,
    execute: def.execute,
    jsonSchema,
    runPreview: async (raw, ctx) => {
      const input = await parseInput(def.input, raw, def.id);
      return parseOutput(def.previewOutput, await def.preview(input, ctx), def.id, 'preview');
    },
    runExecute: async (raw, ctx, permit) => {
      const input = await parseInput(def.input, raw, def.id);
      return parseOutput(def.output, await def.execute(input, ctx, permit), def.id, 'execute');
    },
    toDotAction: () => ({
      id: def.id,
      binding: 'foreman',
      direction: 'in',
      address: `action ${def.id}`,
      summary: def.summary,
      metaSchema: MODULE_META_SCHEMA,
      meta: { kind: 'action', permission: def.permission, risk: def.risk, maxTargets, ...jsonSchema },
    }),
  };
}

/** Define a signal: timestamped evidence a module emits, with a Standard Schema payload. */
export function defineSignal<TPayload extends StandardSchemaV1>(def: SignalDef<TPayload>): Signal<TPayload> {
  assertDefinition(signalMetaSchema, def, `Signal "${def.id}"`);
  return {
    kind: 'signal',
    id: def.id,
    summary: def.summary,
    payload: def.payload,
    jsonSchema: { payload: toJsonSchema(def.payload, 'output', def.id, 'payload') },
  };
}

/**
 * Bundle reads, actions, signals and panels into a versioned module.
 * Checks the module id and version, unique ids, and that every panel names
 * reads and actions the module defines.
 */
export function defineModule<
  TCtx,
  TReads extends Record<string, AnyRead<TCtx>> = Record<string, AnyRead<TCtx>>,
  TActions extends Record<string, AnyAction<TCtx>> = Record<string, AnyAction<TCtx>>,
>(def: ModuleDef<TCtx, TReads, TActions>): ForemanModule<TCtx, TReads, TActions> {
  assertDefinition(moduleMetaSchema, def, `Module "${def.id}"`);
  const reads: TReads = def.reads;
  const actions: TActions = def.actions;
  const signals = def.signals ?? [];
  const panels = def.panels ?? [];
  const capabilities = [...Object.values(reads), ...Object.values(actions)];

  assertUnique(
    capabilities.map(capability => capability.id),
    def.id,
    'read/action',
  );
  assertUnique(
    signals.map(signal => signal.id),
    def.id,
    'signal',
  );
  assertUnique(
    panels.map(panel => panel.id),
    def.id,
    'panel',
  );
  for (const panel of panels) {
    assertDefinition(panelDescriptionSchema, panel, `Panel "${panel.id}" of module "${def.id}"`);
    assertReference(Object.hasOwn(reads, panel.read), def.id, panel.id, 'read', panel.read);
    for (const action of panel.actions) {
      assertReference(Object.hasOwn(actions, action), def.id, panel.id, 'action', action);
    }
  }

  return {
    kind: 'module',
    id: def.id,
    version: def.version,
    reads,
    actions,
    signals,
    panels,
    toDotActions: () => capabilities.map(capability => capability.toDotAction()),
  };
}

/**
 * The module as JSON: JSON Schemas for every input and output, plus a
 * `schemaHash` per read, action and signal. The hash covers the contract
 * (id, kind, permission, risk, target cap and schemas), not the summary, so
 * rewording a summary keeps approvals valid while any contract change voids them.
 */
export async function describeModule(module: AnyForemanModule): Promise<ModuleDescription> {
  const reads = await Promise.all(
    Object.entries(module.reads).map(async ([key, read]): Promise<ReadDescription> => {
      const contract = {
        kind: 'read' as const,
        id: read.id,
        permission: read.permission,
        risk: 'read' as const,
        input: read.jsonSchema.input,
        output: read.jsonSchema.output,
      };
      return { ...contract, key, summary: read.summary, schemaHash: await schemaHash(contract) };
    }),
  );
  const actions = await Promise.all(
    Object.entries(module.actions).map(async ([key, action]): Promise<ActionDescription> => {
      const contract = {
        kind: 'action' as const,
        id: action.id,
        permission: action.permission,
        risk: action.risk,
        maxTargets: action.maxTargets,
        input: action.jsonSchema.input,
        previewOutput: action.jsonSchema.previewOutput,
        output: action.jsonSchema.output,
      };
      return { ...contract, key, summary: action.summary, schemaHash: await schemaHash(contract) };
    }),
  );
  const signals = await Promise.all(
    module.signals.map(async (signal): Promise<SignalDescription> => {
      const contract = { kind: 'signal' as const, id: signal.id, payload: signal.jsonSchema.payload };
      return { ...contract, summary: signal.summary, schemaHash: await schemaHash(contract) };
    }),
  );
  const panels = module.panels.map((panel): PanelDescription => ({
    id: panel.id,
    renderer: panel.renderer,
    read: panel.read,
    actions: [...panel.actions],
  }));
  return { id: module.id, version: module.version, reads, actions, signals, panels };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertDefinition(schema: z.ZodType, value: unknown, label: string): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidDefinition,
      `${label} is invalid:\n${z.prettifyError(result.error)}`,
      'Fix the definition fields named above.',
      { cause: result.error },
    );
  }
}

function assertUnique(ids: readonly string[], moduleId: string, kind: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new AdminError(
        ADMIN_ERROR_CODES.duplicateId,
        `Module "${moduleId}" defines the ${kind} id "${id}" twice.`,
        'Give every read, action, signal and panel of a module its own id.',
      );
    }
    seen.add(id);
  }
}

function assertReference(found: boolean, moduleId: string, panelId: string, kind: string, key: string): void {
  if (!found) {
    throw new AdminError(
      ADMIN_ERROR_CODES.unknownReference,
      `Panel "${panelId}" of module "${moduleId}" names ${kind} "${key}", which the module does not define.`,
      `Use a key of the module's ${kind}s record.`,
    );
  }
}

/** The one JSON Schema dialect admin asks a schema for. */
const JSON_SCHEMA_TARGET = 'draft-2020-12';
const WITH_JSON_SCHEMA_FIX =
  'Wrap the schema with withJsonSchema() from @arki/schema, or use a schema library that can emit JSON Schema.';

/**
 * The schema's JSON Schema: `input` for what a caller sends, `output` for what the server returns.
 * A schema with no converter, or whose conversion throws, is a loud error naming `ownerId` and `field`.
 */
function toJsonSchema(schema: StandardSchemaV1, io: 'input' | 'output', ownerId: string, field: string): JsonObject {
  if (!hasJsonSchema(schema)) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidDefinition,
      `The ${field} schema of "${ownerId}" cannot produce JSON Schema. ${WITH_JSON_SCHEMA_FIX}`,
      WITH_JSON_SCHEMA_FIX,
    );
  }
  let raw: unknown;
  try {
    raw = schema['~standard'].jsonSchema[io]({ target: JSON_SCHEMA_TARGET });
  } catch (error) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidDefinition,
      `The ${field} schema of "${ownerId}" cannot be expressed as JSON Schema. ${WITH_JSON_SCHEMA_FIX}`,
      `Use JSON-representable schemas on the wire: no dates, bigints, maps or custom types. ${WITH_JSON_SCHEMA_FIX}`,
      { cause: error },
    );
  }
  const parsed = jsonObjectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidDefinition,
      `The ${field} schema of "${ownerId}" produced a JSON Schema that is not plain JSON.`,
      'Remove non-JSON values (functions, NaN, Infinity) from schema metadata and defaults.',
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function parseInput<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
  ownerId: string,
): Promise<SchemaOutput<TSchema>> {
  const error = await parseAsync<SchemaOutput<TSchema>>(schema, value);
  if (!InvalidInput.is(error)) return orThrow(error);
  throw new AdminError(
    ADMIN_ERROR_CODES.invalidInput,
    `Input for "${ownerId}" does not match its schema:\n${formatIssues(error.data.issues)}`,
    'Send input that matches the published input JSON Schema.',
    { cause: error },
  );
}

async function parseOutput<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
  ownerId: string,
  step: string,
): Promise<SchemaOutput<TSchema>> {
  const error = await parseAsync<SchemaOutput<TSchema>>(schema, value);
  if (!InvalidInput.is(error)) return orThrow(error);
  throw new AdminError(
    ADMIN_ERROR_CODES.invalidOutput,
    `"${ownerId}" ${step} returned data that does not match its schema:\n${formatIssues(error.data.issues)}`,
    `Fix the ${step} implementation of "${ownerId}" so it returns what its schema declares.`,
    { cause: error },
  );
}

export { redactSecrets } from './redact.ts';
