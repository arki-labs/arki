/**
 * Meta shape stamped on oRPC procedures that are safe to enqueue offline.
 *
 * Apps server-side: `.meta({ offlineSafe: true } satisfies OfflineSafeMeta).use(offlineSafe())`.
 *
 * The marker is documentation-only at the type level — oRPC's client erases
 * procedure meta at the leaf callable, so `useOfflineMutation` requires an
 * explicit `path` rather than reading it from the procedure object. Keeping
 * `.meta({ offlineSafe: true })` on the server side is still useful as
 * declarative intent for codegen, audit tooling, and visual scanning.
 */
export interface OfflineSafeMeta {
  readonly offlineSafe: true;
}
