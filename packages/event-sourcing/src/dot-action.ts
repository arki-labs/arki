import { z } from '@arki/contracts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const EVENT_SOURCING_ACTION_META_SCHEMA = '@arki/event-sourcing/action-meta@1';
export const EVENT_SOURCING_SCHEMA_REJECTED_CODE = 'EVENT_SOURCING_PLUGIN_E007';

export type EventSourcingActionMeta =
  | {
      readonly kind: 'command';
      readonly input: JsonObject;
    }
  | {
      readonly kind: 'event';
      readonly data: JsonObject;
    };

export type EventSourcingActionDeclaration = {
  readonly id: string;
  readonly binding: 'es';
  readonly direction: 'in' | 'out';
  readonly address: string;
  readonly metaSchema: typeof EVENT_SOURCING_ACTION_META_SCHEMA;
  readonly meta: EventSourcingActionMeta;
};

export class EventSourcingActionError extends Error {
  readonly code = EVENT_SOURCING_SCHEMA_REJECTED_CODE;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'EventSourcingActionError';
  }
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) || isJsonPrimitive(right)) return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.hasOwn(right, key) || !jsonDeepEqual(value, right[key])) return false;
  }
  return true;
}

function toJsonObject(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value must be a JSON-serializable object.');
  const parsed = JSON.parse(serialized) as unknown;
  if (!isJsonObject(parsed) || !jsonDeepEqual(value, parsed)) {
    throw new TypeError('Value must be a JSON-serializable object without lossy coercions.');
  }
  return parsed;
}

export function schemaToJsonObject(schema: z.ZodType, label: string): JsonObject {
  try {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    const rest = { ...json };
    delete rest['$schema'];
    return toJsonObject(rest);
  } catch (error) {
    throw new EventSourcingActionError(
      `[event-sourcing] ${label} schema could not be converted to JSON Schema.`,
      error,
    );
  }
}
