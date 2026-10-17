import type { BetterAuthPlugin } from 'better-auth';
import type { OrganizationOptions } from 'better-auth/plugins';
import { organization } from 'better-auth/plugins';

/**
 * Options for the workspace organization plugin. A thin, opinionated surface
 * over Better Auth's `organization` plugin (D-WS-001): teams are first-class
 * (D-WS-007) and access control passes straight through.
 */
export type WorkspacePluginOptions = {
  /** Enable team sub-groups (D-WS-007). Default `true`. */
  teams?: boolean;
  /** Custom access-control instance (from `createAccessControl`). */
  ac?: OrganizationOptions['ac'];
  /** Custom roles. Defaults to Better Auth's owner/admin/member. */
  roles?: OrganizationOptions['roles'];
  /** Cap an organization's member count (seat ceiling). */
  membershipLimit?: OrganizationOptions['membershipLimit'];
  /** Send an invitation email when a member is invited. */
  sendInvitationEmail?: OrganizationOptions['sendInvitationEmail'];
};

/**
 * Build the Better Auth organization plugin configured for Arki workspaces.
 *
 * Pushed into `defineAuthBackend`'s plugin array when `organization.enabled` is
 * set. Expects the org tables (`organization`, `member`, `invitation`, and —
 * when teams are on — `team`, `teamMember`) in the auth schema map.
 */
export function organizationPlugin(options: WorkspacePluginOptions = {}): BetterAuthPlugin {
  const { teams = true, ac, roles, membershipLimit, sendInvitationEmail } = options;

  return organization({
    teams: { enabled: teams },
    ...(ac ? { ac } : {}),
    ...(roles ? { roles } : {}),
    ...(membershipLimit === undefined ? {} : { membershipLimit }),
    ...(sendInvitationEmail ? { sendInvitationEmail } : {}),
  });
}
