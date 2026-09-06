const membersRepo = require('../db/repositories/membersRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const { isTracked } = require('../scheduler/reconcileMembers');
const logger = require('../utils/logger');

/**
 * Live-updates the local member table the moment Discord reports a join/role-change/leave.
 * Genuine Discord presence (join/leave) and the monitored role (tracked/untracked) are handled
 * independently — see scheduler/reconcileMembers.js for why that separation matters.
 */
function registerMemberEvents(client) {
  client.on('guildMemberAdd', (member) => {
    if (member.user.bot) return;

    const displayName = member.displayName ?? member.user.username;
    membersRepo.recordJoin(member.id, displayName, (member.joinedAt ?? new Date()).toISOString(), false);

    const monitoredRoleId = settingsRepo.getMonitoredRoleId();
    membersRepo.setTracked(member.id, isTracked(member, monitoredRoleId));
    logger.info({ memberId: member.id }, 'Member joined');
  });

  client.on('guildMemberUpdate', (oldMember, newMember) => {
    const monitoredRoleId = settingsRepo.getMonitoredRoleId();
    if (!monitoredRoleId) return; // no role configured: tracked status doesn't depend on roles

    const wasTracked = isTracked(oldMember, monitoredRoleId);
    const nowTracked = isTracked(newMember, monitoredRoleId);
    if (wasTracked === nowTracked) return;

    // Only flips visibility — never touches joined_at or loot-eligibility progress.
    membersRepo.setTracked(newMember.id, nowTracked);
    logger.info({ memberId: newMember.id }, nowTracked ? 'Member gained the tracked role' : 'Member lost the tracked role');
  });

  client.on('guildMemberRemove', (member) => {
    membersRepo.recordLeave(member.id, new Date().toISOString());
    logger.info({ memberId: member.id }, 'Member left the Discord server');
  });
}

module.exports = { registerMemberEvents };
