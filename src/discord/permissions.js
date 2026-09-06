const { PermissionFlagsBits } = require('discord.js');
const settingsRepo = require('../db/repositories/settingsRepo');

/**
 * Whether the invoking member may run a command marked `restricted` (see interactionHandler.js).
 * Admins (Manage Server permission) always pass, regardless of the commands-role setting.
 * Everyone else needs to hold the role configured via /setup commands-role — until an admin sets
 * one, nobody but admins can use these commands at all. /stats is deliberately never gated by
 * this: it stays open to everyone.
 */
function hasCommandsAccess(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  const roleId = settingsRepo.getCommandsRoleId();
  if (!roleId) return false;

  return interaction.member?.roles?.cache?.has(roleId) ?? false;
}

module.exports = { hasCommandsAccess };
