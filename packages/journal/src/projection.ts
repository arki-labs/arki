/**
 * `dot explain --as journal-flow`: which event starts which effect.
 *
 * Nothing new is collected for it. Every effect is already a manifest action
 * whose meta lists the events it handles (`journalHandlers` /
 * `journalEffects` write it), so this module only reads the manifest and
 * turns each (event, effect) pair into an edge. The reactive part of an app —
 * "paying an order sends a mail" — is otherwise invisible: no import and no
 * call connects the command to the effect.
 *
 * Loaded by the Dot CLI from the app's manifest; it imports neither Dot nor
 * the journal, so it runs without booting anything.
 */
import { JOURNAL_ACTION_META_SCHEMA } from './action-meta.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ActionLike = {
  readonly id: string;
  readonly plugin: string;
  readonly binding: string;
  readonly address?: string;
  readonly metaSchema?: string;
  readonly meta?: Readonly<Record<string, JsonValue>>;
};

type ManifestLike = { readonly actions: readonly ActionLike[] };

/** One subscription: `event` starts `effect`, an effect of the feature (`plugin`) that lists it. */
export type JournalFlowEdge = {
  readonly event: string;
  readonly effect: string;
  readonly plugin: string;
  readonly entities: readonly string[];
};

export type JournalFlowDocument = {
  readonly format: 'journal-flow';
  readonly edges: readonly JournalFlowEdge[];
};

const strings = (value: JsonValue | undefined): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The event → effect edges of every journal effect in the manifest, in manifest order. */
export function project(manifest: ManifestLike): JournalFlowDocument {
  const edges: JournalFlowEdge[] = [];
  for (const action of manifest.actions) {
    if (action.binding !== 'journal' || action.metaSchema !== JOURNAL_ACTION_META_SCHEMA) continue;
    const effect = action.address ?? action.id;
    const entities = strings(action.meta?.['entities']);
    for (const event of strings(action.meta?.['events']))
      edges.push({ event, effect, plugin: action.plugin, entities });
  }
  return { format: 'journal-flow', edges };
}
