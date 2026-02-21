/**
 * Trust Level System — controls auto-approval of plugin deploys
 */

export enum TrustLevel {
  APPROVE_EACH = 'approve_each',
  APPROVE_NEW = 'approve_new',
  PEACOCK = 'peacock',
}

export const TRUST_LEVELS = Object.values(TrustLevel);

export function isValidTrustLevel(level: string): level is TrustLevel {
  return TRUST_LEVELS.includes(level as TrustLevel);
}

/**
 * Determine if a deploy should be auto-approved based on trust level.
 *
 * @param trustLevel - Current node trust level
 * @param isNewPlugin - Whether this is a brand new plugin (not an update)
 * @param hasPermissionChange - Whether the update includes permission escalation
 * @returns true if the deploy should proceed without user approval
 */
export function shouldAutoApprove(
  trustLevel: TrustLevel,
  isNewPlugin: boolean,
  hasPermissionChange: boolean
): boolean {
  switch (trustLevel) {
    case TrustLevel.PEACOCK:
      // Full autonomy — always auto-approve
      return true;

    case TrustLevel.APPROVE_NEW:
      // Auto-approve updates to existing tools ONLY if no permission escalation
      // New tools or permission escalations always need approval
      return !isNewPlugin && !hasPermissionChange;

    case TrustLevel.APPROVE_EACH:
      // Every deploy needs approval
      return false;

    default:
      // Unknown trust level — safe default: require approval
      return false;
  }
}

export function trustLevelLabel(level: TrustLevel): string {
  switch (level) {
    case TrustLevel.APPROVE_EACH: return '🔒 Approve Each — every deploy needs approval';
    case TrustLevel.APPROVE_NEW: return '✅ Approve New Only — updates auto-deploy, new tools need approval';
    case TrustLevel.PEACOCK: return '🦚 Peacock Mode — full autonomy, cloud deploys freely';
    default: return level;
  }
}
