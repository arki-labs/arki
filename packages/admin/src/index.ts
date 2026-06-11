/**
 * @arki/admin — isomorphic entry.
 *
 * Re-exports the fleet contract (schemas + types + constants). Safe to import
 * from browser or server code; it carries no secrets and no Node built-ins.
 * Server-only helpers (request handler, federation fetch) live in
 * `@arki/admin/server`.
 */
export * from './contract';
