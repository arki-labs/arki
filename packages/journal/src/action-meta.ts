/**
 * The schema tag on every journal action in a Dot manifest. Its own module so
 * the `dot explain` projection can read it without loading Dot or the journal.
 */
export const JOURNAL_ACTION_META_SCHEMA = '@arki/journal/action-meta@1';
