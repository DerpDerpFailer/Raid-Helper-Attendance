import { describe, it, expect } from 'vitest';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';

const { isValidDate, dayCount, MAX_VACATION_DAYS } = require('../../src/discord/vacationInteractions');

describe('discord/vacationInteractions isValidDate', () => {
  it('accepts a well-formed calendar date', () => {
    expect(isValidDate('2026-09-14')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isValidDate('14-09-2026')).toBe(false);
    expect(isValidDate('2026/09/14')).toBe(false);
    expect(isValidDate('not-a-date')).toBe(false);
    expect(isValidDate('')).toBe(false);
  });

  it('rejects a calendar date that does not exist', () => {
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
  });
});

describe('discord/vacationInteractions dayCount', () => {
  it('counts a single day as 1', () => {
    expect(dayCount('2026-09-14', '2026-09-14')).toBe(1);
  });

  it('counts an inclusive range correctly', () => {
    expect(dayCount('2026-09-14', '2026-09-18')).toBe(5);
  });

  it('MAX_VACATION_DAYS is the confirmed 2-week cap', () => {
    expect(MAX_VACATION_DAYS).toBe(14);
  });
});
