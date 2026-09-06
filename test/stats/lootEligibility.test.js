import { describe, it, expect, beforeAll } from 'vitest';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';

const { migrate } = require('../../src/db/migrate');
const { getDb } = require('../../src/db/connection');
const { processLootEligibility, step, traceMemberHistory } = require('../../src/stats/lootEligibility');
const lootRepo = require('../../src/db/repositories/lootRepo');

const THRESHOLDS = { ineligibleAfterDays: 3, recoveryDays: 7, recoveryGapDays: 2 };

function run(days, initial = { eligible: true, consecutiveMissedDays: 0, accumulatedSignedDays: 0 }, thresholds = THRESHOLDS) {
  return days.reduce((state, signed) => step(state, signed, thresholds), initial);
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

describe('stats/lootEligibility step() — recoveryGapDays independent from ineligibleAfterDays', () => {
  const droppedState = { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 0 };

  it('recoveryGapDays: 0 requires recovery in strictly consecutive signed days — any single miss resets', () => {
    const thresholds = { ...THRESHOLDS, recoveryGapDays: 0 };
    let state = run([true, true], droppedState, thresholds); // 2 signed, accumulated=2
    expect(state).toMatchObject({ accumulatedSignedDays: 2, eligible: false });

    state = run([false], state, thresholds); // a single missed day is enough to wipe it
    expect(state).toMatchObject({ accumulatedSignedDays: 0, eligible: false });

    // 7 strictly consecutive signed days recovers.
    state = run([true, true, true, true, true, true, true], droppedState, thresholds);
    expect(state).toMatchObject({ eligible: true });
  });

  it('recoveryGapDays: 1 tolerates one missed day in a row, but not two', () => {
    const thresholds = { ...THRESHOLDS, recoveryGapDays: 1 };
    let state = run([true, false, true, true, true, true, true], droppedState, thresholds);
    // 1 signed, 1 missed (tolerated, progress kept at 1), then 5 more signed = 6 total.
    expect(state).toMatchObject({ accumulatedSignedDays: 6, eligible: false });

    state = run([true], state, thresholds); // the 7th signed day -> recovers
    expect(state).toMatchObject({ eligible: true });

    // But two consecutive missed days do wipe progress.
    let interrupted = run([true, true, false, false], droppedState, thresholds);
    expect(interrupted).toMatchObject({ accumulatedSignedDays: 0, eligible: false });
  });

  it('recoveryGapDays: 2 matches the historical default behavior (2 tolerated, 3 resets)', () => {
    const thresholds = { ...THRESHOLDS, recoveryGapDays: 2 };
    // 1 signed, 2 missed (tolerated — cmd never reaches 3), then 6 more signed = 7 total -> recovers.
    const tolerated = run([true, false, false, true, true, true, true, true, true], droppedState, thresholds);
    expect(tolerated).toMatchObject({ eligible: true });

    const wiped = run([true, false, false, false], droppedState, thresholds);
    expect(wiped).toMatchObject({ accumulatedSignedDays: 0, eligible: false });
  });

  it('is fully independent from ineligibleAfterDays: changing one does not affect the other', () => {
    // A much stricter drop threshold (1 missed day drops immediately) combined with a very
    // permissive recovery gap (5 missed days tolerated during recovery).
    const thresholds = { ineligibleAfterDays: 1, recoveryDays: 7, recoveryGapDays: 5 };

    // Drops after just 1 missed day (ineligibleAfterDays: 1), starting from eligible.
    const dropped = run([false], { eligible: true, consecutiveMissedDays: 0, accumulatedSignedDays: 0 }, thresholds);
    expect(dropped.eligible).toBe(false);

    // While recovering, 5 consecutive missed days are tolerated without wiping progress.
    let state = run([true, true], droppedState, thresholds); // accumulated=2
    state = run([false, false, false, false, false], state, thresholds); // 5 missed, tolerated
    expect(state).toMatchObject({ accumulatedSignedDays: 2, eligible: false });

    // The 6th consecutive missed day exceeds the gap and wipes it.
    state = run([false], state, thresholds);
    expect(state).toMatchObject({ accumulatedSignedDays: 0, eligible: false });
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

function seedDaySequence(memberId, prefix, days, signedDays) {
  days.forEach((day, i) => {
    const eventId = `${prefix}_evt${i}`;
    seedEvent(eventId, `${day}T18:00:00.000Z`);
    if (signedDays.has(day)) seedSignup(eventId, memberId);
  });
}

describe('stats/lootEligibility traceMemberHistory (powers /eligibility-loot-detail)', () => {
  it('reports no reset/change for a member who has never yet reached eligibility', () => {
    // Bob never signs at all: he started ineligible (new member) and stays ineligible — there is
    // no "drop" to report, since he never had eligibility to drop from, and never hit the 3-day
    // reset threshold beyond his very first (only) miss streak reaching it once.
    const bob = traceMemberHistory('bob', new Date('2026-08-06T00:00:00.000Z'));
    expect(bob.finalState).toMatchObject({ eligible: false, consecutiveMissedDays: 4, accumulatedSignedDays: 0 });
    expect(bob.trace.map((e) => e.day)).toEqual(['2026-08-01', '2026-08-03', '2026-08-04', '2026-08-05']);

    // Alice signed all 4 event-days but 4 < the default recoveryDays (7): still working toward
    // her very first eligibility, so no reset/transition has happened for her either.
    const alice = traceMemberHistory('alice', new Date('2026-08-06T00:00:00.000Z'));
    expect(alice.lastEligibleChangeDay).toBeNull();
    expect(alice.lastResetDay).toBeNull();
    expect(alice.finalState).toMatchObject({ eligible: false, accumulatedSignedDays: 4 });
  });

  it('reports a clean single drop when there has been no reset since', () => {
    seedMember('dave2', 'Dave2', '2026-01-01T00:00:00.000Z');
    const days = [
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', // 7 signed -> eligible on 09-07
      '2026-09-08', '2026-09-09', '2026-09-10', // 3 missed -> drops on 09-10
      '2026-09-11', '2026-09-12', // 2 signed since, no further gap
    ];
    const signed = new Set(days.slice(0, 7).concat(days.slice(10)));
    seedDaySequence('dave2', 'dave2', days, signed);

    const result = traceMemberHistory('dave2', new Date('2026-09-13T00:00:00.000Z'));

    expect(result.lastEligibleChangeDay).toBe('2026-09-10');
    expect(result.lastResetDay).toBe('2026-09-10'); // same day: no reset has happened since the drop
    expect(result.finalState).toMatchObject({ eligible: false, accumulatedSignedDays: 2 });
  });

  it('reports the SirOlaf case: a later reset is more recent than the original drop', () => {
    seedMember('sirolaf', 'SirOlaf', '2026-01-01T00:00:00.000Z');
    const days = [
      '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', // 7 signed -> eligible on 09-07
      '2026-09-08', '2026-09-09', '2026-09-10', // 3 missed -> drops on 09-10 (original drop)
      '2026-09-11', '2026-09-12', // 2 signed toward recovery (accum=2)
      '2026-09-13', '2026-09-14', '2026-09-15', // 3 more missed -> a SECOND reset on 09-15, wiping that progress
      '2026-09-16', '2026-09-17', // 2 signed again since the second reset
    ];
    const signed = new Set([...days.slice(0, 7), ...days.slice(10, 12), ...days.slice(15)]);
    seedDaySequence('sirolaf', 'sirolaf', days, signed);

    const result = traceMemberHistory('sirolaf', new Date('2026-09-18T00:00:00.000Z'));

    expect(result.lastEligibleChangeDay).toBe('2026-09-10'); // the original drop
    expect(result.lastResetDay).toBe('2026-09-15'); // the more recent reset — this is what should anchor the display
    expect(result.finalState).toMatchObject({ eligible: false, accumulatedSignedDays: 2 });
    // The display window anchors on the more recent reset, not the older original drop.
    expect(result.trace.filter((e) => e.day >= result.lastResetDay).map((e) => e.day))
      .toEqual(['2026-09-15', '2026-09-16', '2026-09-17']);
  });
});
