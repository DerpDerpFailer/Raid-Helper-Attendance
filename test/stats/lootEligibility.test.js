import { describe, it, expect, beforeAll } from 'vitest';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';

const { migrate } = require('../../src/db/migrate');
const { getDb } = require('../../src/db/connection');
const { processLootEligibility, step } = require('../../src/stats/lootEligibility');
const lootRepo = require('../../src/db/repositories/lootRepo');

const THRESHOLDS = { ineligibleAfterDays: 3, recoveryDays: 7 };

function run(days, initial = { eligible: true, consecutiveMissedDays: 0, accumulatedSignedDays: 0 }) {
  return days.reduce((state, signed) => step(state, signed, THRESHOLDS), initial);
}

describe('stats/lootEligibility step() — the three worked examples from the spec', () => {
  it('John: 3 consecutive missed days drops eligibility, then 7 signed days restores it', () => {
    // F F F -> drop, then T x7 -> recovered
    const final = run([false, false, false, true, true, true, true, true, true, true]);
    expect(final.eligible).toBe(true);
  });

  it('John, intermediate: exactly 3 missed days is enough to drop, not before', () => {
    expect(run([false, false]).eligible).toBe(true); // only 2 so far
    expect(run([false, false, false]).eligible).toBe(false); // the 3rd drops it
  });

  it('David: drops after 3 missed, then 3 signed + 1 missed (gap under threshold) + 4 signed = 7 total -> recovers', () => {
    const final = run([false, false, false, true, true, true, false, true, true, true, true]);
    expect(final.eligible).toBe(true);

    // One day short of recovery (only 6 accumulated) must still be ineligible.
    const oneShort = run([false, false, false, true, true, true, false, true, true, true]);
    expect(oneShort.eligible).toBe(false);
  });

  it('Hector: a 2-day gap does not drop eligibility, but a subsequent 3-day gap does', () => {
    // F F (2 missed, still eligible) T T T (signs 3, still eligible) F F F (3 missed -> drops)
    const afterTwoMissed = run([false, false]);
    expect(afterTwoMissed.eligible).toBe(true);

    const afterSigning = run([false, false, true, true, true]);
    expect(afterSigning.eligible).toBe(true);

    const final = run([false, false, true, true, true, false, false, false]);
    expect(final.eligible).toBe(false);
  });

  it('a fresh 3-day gap while already ineligible resets recovery progress to zero', () => {
    // Drop (F F F), sign 5 days toward recovery (accumulated=5, not yet 7), then miss 3 more days
    // -> recovery progress wipes back to 0, still ineligible.
    let state = { eligible: true, consecutiveMissedDays: 0, accumulatedSignedDays: 0 };
    state = run([false, false, false], state);
    expect(state).toMatchObject({ eligible: false, accumulatedSignedDays: 0 });

    state = run([true, true, true, true, true], state);
    expect(state).toMatchObject({ eligible: false, accumulatedSignedDays: 5 });

    state = run([false, false, false], state);
    expect(state).toMatchObject({ eligible: false, accumulatedSignedDays: 0 });
  });
});

function seedMember(id, displayName, joinedAt) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO members (id, display_name, is_active, joined_at, first_seen_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
  `).run(id, displayName, joinedAt, joinedAt, now);
}

function seedEvent(id, startTime) {
  const db = getDb();
  db.prepare('INSERT INTO events (id, title, start_time, last_synced_at) VALUES (?, ?, ?, ?)')
    .run(id, `Event ${id}`, startTime, startTime);
}

function seedSignup(eventId, memberId) {
  const db = getDb();
  db.prepare('INSERT INTO signups (event_id, member_id, status, updated_at) VALUES (?, ?, ?, ?)')
    .run(eventId, memberId, 'Accepted', new Date().toISOString());
}

describe('stats/lootEligibility processLootEligibility (integration)', () => {
  beforeAll(() => {
    migrate();
    // Alice joined well before any of this data; signs every event day -> stays eligible.
    seedMember('alice', 'Alice', '2026-01-01T00:00:00.000Z');
    // Bob joined at the same time but never signs anything -> should drop after 3 event-days.
    seedMember('bob', 'Bob', '2026-01-01T00:00:00.000Z');

    // Day 1: event, both could sign. Day 2: NO event at all (must be neutral, skipped).
    // Day 3, 4: events, neither signs -> only 2 non-neutral missed days so far for Bob.
    // Day 5: event, Bob still doesn't sign -> that's his 3rd non-neutral missed day -> drops.
    seedEvent('e1', '2026-08-01T18:00:00.000Z');
    // no event on 2026-08-02 — intentionally skipped
    seedEvent('e3', '2026-08-03T18:00:00.000Z');
    seedEvent('e4', '2026-08-04T18:00:00.000Z');
    seedEvent('e5', '2026-08-05T18:00:00.000Z');

    seedSignup('e1', 'alice');
    seedSignup('e3', 'alice');
    seedSignup('e4', 'alice');
    seedSignup('e5', 'alice');
    // Bob signs nothing.
  });

  it('treats a day with zero events as neutral, and only counts event-days toward the 3-day drop', () => {
    // "Now" is 2026-08-06 — every event above is in the past, none upcoming.
    processLootEligibility(new Date('2026-08-06T00:00:00.000Z'));

    const alice = lootRepo.getRow('alice');
    const bob = lootRepo.getRow('bob');

    expect(alice.eligible).toBe(0); // starts ineligible (never processed before) — she's only
    // signed 4 days, not yet the 7 needed to earn initial eligibility.
    expect(alice.accumulated_signed_days).toBe(4);
    expect(alice.consecutive_missed_days).toBe(0);

    // Bob: e1 (missed, cmd=1), 08-02 skipped (no event), e3 (missed, cmd=2), e4 (missed, cmd=3 ->
    // stays ineligible, which it already was since he's new), e5 (missed, cmd=4).
    expect(bob.eligible).toBe(0);
    expect(bob.consecutive_missed_days).toBe(4);
    expect(bob.last_processed_day).toBe('2026-08-05');
  });

  it('is idempotent: re-running with the same "now" does not double-count', () => {
    const before = lootRepo.getRow('alice');
    processLootEligibility(new Date('2026-08-06T00:00:00.000Z'));
    const after = lootRepo.getRow('alice');
    expect(after).toEqual(before);
  });

  it('losing/regaining the tracked role hides then restores a member without resetting their progress (the DerpyFailer/Creeday bug)', () => {
    const membersRepo = require('../../src/db/repositories/membersRepo');
    const beforeToggle = lootRepo.getRow('alice');

    // Simulate an admin removing then re-adding the monitored role — NOT a real Discord leave.
    membersRepo.setTracked('alice', false);
    expect(lootRepo.getTrackedWithState().find((r) => r.member_id === 'alice')).toBeUndefined();

    // While untracked, processing must skip her entirely (no state change).
    processLootEligibility(new Date('2026-08-10T00:00:00.000Z'));
    expect(lootRepo.getRow('alice')).toEqual(beforeToggle);

    membersRepo.setTracked('alice', true);
    const afterToggle = lootRepo.getRow('alice');
    // joined_at and prior progress must be untouched by the role toggle itself.
    expect(afterToggle).toEqual(beforeToggle);
    const member = membersRepo.getById('alice');
    expect(member.joined_at).toBe('2026-01-01T00:00:00.000Z'); // unchanged from seedMember
  });
});
