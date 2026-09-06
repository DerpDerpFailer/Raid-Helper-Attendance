import { describe, it, expect, beforeAll } from 'vitest';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';

const { migrate } = require('../../src/db/migrate');
const membersRepo = require('../../src/db/repositories/membersRepo');

describe('db/repositories/membersRepo ensureExists', () => {
  beforeAll(() => {
    migrate();
  });

  it('creates an inactive/untracked placeholder, not an active one', () => {
    membersRepo.ensureExists('placeholder1', 'PlaceholderName');
    const row = membersRepo.getById('placeholder1');

    expect(row.is_active).toBe(0);
    expect(row.is_tracked).toBe(0);
  });

  it('does not overwrite an already-known member', () => {
    membersRepo.recordJoin('known1', 'Known', '2026-01-01T00:00:00.000Z', false);
    membersRepo.ensureExists('known1', 'SomeOtherName');

    const row = membersRepo.getById('known1');
    expect(row.display_name).toBe('Known'); // unchanged, ensureExists is a no-op for existing rows
    expect(row.joined_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('regression: a fresh backfill (ensureExists) followed by reconciliation (recordJoin) ends up with the real Discord join date, not the backfill timestamp', () => {
    // Simulates the exact fresh-deploy sequence: runBackfill() creates the placeholder via
    // ensureExists first (real code path: signupsRepo.replaceForEvent -> ensureExists), then
    // reconcileMembers() runs and must recognize it as "not yet properly tracked" (is_active=0)
    // to correct its joined_at — this used to silently fail because ensureExists inserted as
    // already active, so reconcileMembers's `existing.is_active === 0` check never fired for it.
    membersRepo.ensureExists('fresh_member', 'FreshMember');
    const placeholder = membersRepo.getById('fresh_member');
    expect(placeholder.is_active).toBe(0); // must be 0 for the next step to trigger correctly

    // This mirrors reconcileMembers.js's exact branch condition.
    const shouldRecordJoin = !placeholder || placeholder.is_active === 0;
    expect(shouldRecordJoin).toBe(true);

    const realDiscordJoinDate = '2026-03-15T09:00:00.000Z'; // long before the placeholder was created
    membersRepo.recordJoin('fresh_member', 'FreshMember', realDiscordJoinDate, false);

    const reconciled = membersRepo.getById('fresh_member');
    expect(reconciled.joined_at).toBe(realDiscordJoinDate);
    expect(reconciled.is_active).toBe(1);
  });
});
