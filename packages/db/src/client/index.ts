/**
 * @arki/db/client — types-only client surface.
 *
 * V1 is intentionally empty: this subpath claims the namespace for future
 * Drizzle-on-client / Tier-3 sync work (Electric / PowerSync / Zero adapters).
 * No runtime imports are allowed here — this file must remain free of any
 * server-only dependencies (postgres, drizzle-orm connection utilities, etc.).
 *
 * See docs/superpowers/specs/2026-05-16-arki-offline-design.md §3.3.
 */
export type * from './ids.js';
