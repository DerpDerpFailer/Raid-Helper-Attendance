const membersRepo = require('../db/repositories/membersRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const logger = require('../utils/logger');

/**
 * Whether a guild member currently holds the monitored role (/setup role). Falls back to "not a
 * bot account" when no role is configured — the bot's behavior before /setup existed. This is
 * purely about *visibility* in stats/loot, never about tenure — see reconcileMembers below.
 */
function isTracked(member, monitoredRoleId) {
  if (monitoredRoleId) return member.roles.cache.has(monitoredRoleId);
  return !member.user.bot;
}

/**
 * Daily safety net for live join/leave/role-change events, in case the bot missed one (was
 * offline). Idempotent — safe to run as often as needed.
 *
 * Two independent signals, deliberately never conflated:
 *  - is_active / joined_at / left_at: real Discord presence. Only a genuine leave+rejoin resets
 *    the tenure clock — this is what /eligibility-loot and the 14-day ranking grace period key off.
 *  - is_tracked: does this member currently hold the monitored role right now. Toggling it just
 *    shows/hides them in stats; it never touches tenure or wipes loot-eligibility progress. This
 *    is what keeps a role misconfiguration or a bot restart glitch from unfairly penalizing
 *    veteran members who never actually left the server.
 */
async function reconcileMembers(guild) {
  const roster = await guild.members.fetch();
  const monitoredRoleId = settingsRepo.getMonitoredRoleId();
  const now = new Date().toISOString();
  const presentIds = new Set();

  for (const member of roster.values()) {
    if (member.user.bot) {
      presentIds.add(member.id); // still "present" so we don't spuriously mark bots as departed
      continue;
    }

    presentIds.add(member.id);
    const displayName = member.displayName ?? member.user.username;
    const existing = membersRepo.getById(member.id);

    if (!existing || existing.is_active === 0) {
      // Genuine (re)join of the Discord server — tenure resets from their real Discord join date.
      membersRepo.recordJoin(member.id, displayName, (member.joinedAt ?? new Date()).toISOString(), false);
    } else {
      membersRepo.updateDisplayName(member.id, displayName);
    }

    membersRepo.setTracked(member.id, isTracked(member, monitoredRoleId));
  }

  for (const localMember of membersRepo.getAll()) {
    if (localMember.is_active === 1 && !presentIds.has(localMember.id)) {
      membersRepo.recordLeave(localMember.id, now);
      logger.info({ memberId: localMember.id }, 'Member marked as departed (left the Discord server)');
    }
  }

  logger.info({ rosterSize: roster.size, presentCount: presentIds.size }, 'Member reconciliation complete');
}

module.exports = { reconcileMembers, isTracked };
