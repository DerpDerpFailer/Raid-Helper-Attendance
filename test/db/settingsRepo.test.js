import { describe, it, expect, beforeAll } from 'vitest';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';
process.env.PERIOD_MODE = 'week';
process.env.PERIOD_ROLLING_DAYS = '30';
process.env.ELIGIBILITY_MIN_DAYS = '14';

const { migrate } = require('../../src/db/migrate');
const settingsRepo = require('../../src/db/repositories/settingsRepo');

describe('db/repositories/settingsRepo', () => {
  beforeAll(() => {
    migrate();
  });

  it('falls back to the env-var defaults (config.js) until /setup overrides them', () => {
    expect(settingsRepo.getPeriodMode()).toBe('week');
    expect(settingsRepo.getPeriodRollingDays()).toBe(30);
    expect(settingsRepo.getEligibilityMinDays()).toBe(14);
    expect(settingsRepo.getDropoutThresholds()).toEqual({
      alertRank: 15, alertScore: 0.15, criticalRank: 30, criticalScore: 0.30,
    });
    expect(settingsRepo.getTopFlopSize()).toBe(10); // config.js default (TOP_FLOP_SIZE unset)
    expect(settingsRepo.getPollIntervalMinutes()).toBe(20); // config.js default (POLL_INTERVAL_MINUTES unset)
  });

  it('persists overrides made via the /setup setters', () => {
    settingsRepo.setPeriodMode('rolling');
    settingsRepo.setPeriodRollingDays(45);
    settingsRepo.setEligibilityMinDays(21);
    settingsRepo.setTopFlopSize(15);
    settingsRepo.setPollIntervalMinutes(5);

    expect(settingsRepo.getPeriodMode()).toBe('rolling');
    expect(settingsRepo.getPeriodRollingDays()).toBe(45);
    expect(settingsRepo.getEligibilityMinDays()).toBe(21);
    expect(settingsRepo.getTopFlopSize()).toBe(15);
    expect(settingsRepo.getPollIntervalMinutes()).toBe(5);
  });

  it('commands role defaults to unset (admins-only) until /setup commands-role overrides it', () => {
    expect(settingsRepo.getCommandsRoleId()).toBeNull();

    settingsRepo.setCommandsRoleId('role-123');
    expect(settingsRepo.getCommandsRoleId()).toBe('role-123');
  });

  it('only overrides the dropout thresholds explicitly passed to setDropoutThresholds', () => {
    settingsRepo.setDropoutThresholds({ alertRank: 10 });
    expect(settingsRepo.getDropoutThresholds()).toEqual({
      alertRank: 10, alertScore: 0.15, criticalRank: 30, criticalScore: 0.30,
    });

    settingsRepo.setDropoutThresholds({ criticalScore: 0.5 });
    expect(settingsRepo.getDropoutThresholds()).toEqual({
      alertRank: 10, alertScore: 0.15, criticalRank: 30, criticalScore: 0.5,
    });
  });
});
