/**
 * Branded ID type re-exports for the client surface.
 *
 * V1: @arki/contracts does not yet export named branded ID types.
 * Future versions will re-export them here once they are defined, e.g.:
 *
 *   export type { UserId, OrgId, AssetId } from '@arki/contracts';
 *
 * See packages/offline/docs/2026-05-16-arki-offline-design.md §3.3.
 */
// eslint-disable-next-line unicorn/require-module-specifiers -- an intentionally empty module: client/index.ts re-exports it with `export type *`, so it must stay a module until branded ID types exist.
export type {};
