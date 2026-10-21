/**
 * The old path of `unit-contract.ts`, kept only while other sessions'
 * uncommitted files still import it. The last step of the Dot vocabulary
 * rename deletes this file (RFC `docs/rfcs/2026-10-15-dot-feature-builder.md`,
 * amendment 2026-10-21; `.work/codemods/dot-unit-rename.py --data-keys`).
 */
export * from './unit-contract.js';
export { infra as plugin } from './unit-contract.js';
export type { UnitPhases as PluginPhases } from './unit-contract.js';
