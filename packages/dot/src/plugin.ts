/**
 * The old `@arki/dot/plugin` subpath, kept only while other sessions'
 * uncommitted files still import it. Use `@arki/dot/unit`. The last step of
 * the Dot vocabulary rename deletes this file (RFC
 * `docs/rfcs/2026-10-15-dot-feature-builder.md`, amendment 2026-10-21).
 */
export * from './unit.js';
export { plugin } from './plugin-contract.js';
export type { PluginPhases } from './plugin-contract.js';
