import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';

const { migrate } = require('../../src/db/migrate');
const settingsRepo = require('../../src/db/repositories/settingsRepo');
const { hasCommandsAccess } = require('../../src/discord/permissions');

function fakeInteraction({ isAdmin = false, roleIds = [] } = {}) {
  return {
    memberPermissions: new PermissionsBitField(isAdmin ? [PermissionFlagsBits.ManageGuild] : []),
    member: { roles: { cache: new Set(roleIds) } },
  };
}

describe('discord/permissions hasCommandsAccess', () => {
  beforeAll(() => {
    migrate();
  });

  beforeEach(() => {
    settingsRepo.setCommandsRoleId(null);
  });

  it('always lets an admin (Manage Server) through, regardless of the commands-role setting', () => {
    expect(hasCommandsAccess(fakeInteraction({ isAdmin: true }))).toBe(true);

    settingsRepo.setCommandsRoleId('officer-role');
    expect(hasCommandsAccess(fakeInteraction({ isAdmin: true, roleIds: [] }))).toBe(true);
  });

  it('denies non-admins until an admin has configured a commands-role', () => {
    expect(hasCommandsAccess(fakeInteraction({ isAdmin: false }))).toBe(false);
  });

  it('lets a non-admin through once they hold the configured commands-role', () => {
    settingsRepo.setCommandsRoleId('officer-role');

    expect(hasCommandsAccess(fakeInteraction({ isAdmin: false, roleIds: ['officer-role'] }))).toBe(true);
    expect(hasCommandsAccess(fakeInteraction({ isAdmin: false, roleIds: ['some-other-role'] }))).toBe(false);
  });
});
