const { getDb } = require('../db/connection');
const lootRepo = require('../db/repositories/lootRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const vacationRepo = require('../db/repositories/vacationRepo');
const { startOfUTCDate, addDays } = require('../utils/dates');
const logger = require('../utils/logger');

function dayKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function dayBefore(dayStr) {
  return dayKey(addDays(new Date(`${dayStr}T00:00:00.000Z`), -1));
}

/**
 * One day's state transition. `signedToday` means the member had at least one sign-up (any
 * status — Accepted/Tentative/Absence/etc. all count) for an event that happened that day.
 *
 *  - Signed: consecutive-missed resets to 0. If currently ineligible, one day of recovery
 *    progress accrues; reaching `recoveryDays` restores eligibility.
 *  - Not signed, currently eligible: consecutive-missed grows; hitting `ineligibleAfterDays`
 *    drops eligibility.
 *  - Not signed, already ineligible (recovering): consecutive-missed grows; hitting
 *    `recoveryGapDays + 1` wipes the in-progress recovery back to zero. This is a threshold
 *    independent from `ineligibleAfterDays` — it only controls how forgiving *regaining*
 *    eligibility is, not how eligibility is lost in the first place. `recoveryGapDays` is how
 *    many consecutive missed days are tolerated without losing progress (0 = recovery must be
 *    done in `recoveryDays` strictly consecutive signed days).
 */
function step(state, signedToday, thresholds) {
  let { eligible, consecutiveMissedDays, accumulatedSignedDays } = state;

  if (signedToday) {
    consecutiveMissedDays = 0;
    if (!eligible) {
      accumulatedSignedDays += 1;
      if (accumulatedSignedDays >= thresholds.recoveryDays) {
        eligible = true;
        accumulatedSignedDays = 0;
      }
    }
  } else {
    consecutiveMissedDays += 1;

    if (eligible) {
      if (consecutiveMissedDays >= thresholds.ineligibleAfterDays) {
        eligible = false;
        accumulatedSignedDays = 0;
      }
    } else if (consecutiveMissedDays >= thresholds.recoveryGapDays + 1) {
      accumulatedSignedDays = 0;
    }
  }

  return { eligible, consecutiveMissedDays, accumulatedSignedDays };
}

/**
 * A member's effective loot-eligibility replay starting point and initial state. Normally that's
 * their real tracked join day, starting ineligible with zero progress (they earn eligibility the
 * same way anyone recovering does). But if a /setup loot-amnesty-date is configured and this
 * member was already tracked on or before it, the replay instead starts AT the amnesty date, as
 * already eligible — a one-time "everyone already here starts fresh" cutover. Members who joined
 * after the amnesty date are unaffected: they still earn it normally from their own join day.
 */
function getReplayStart(joinedDay) {
  const amnestyDate = settingsRepo.getLootAmnestyDate();
  if (amnestyDate && joinedDay <= amnestyDate) {
    return {
      startDay: amnestyDate,
      initialState: { eligible: true, consecutiveMissedDays: 0, accumulatedSignedDays: 0 },
      amnestyApplied: true,
    };
  }
  return {
    startDay: joinedDay,
    initialState: { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 0 },
    amnestyApplied: false,
  };
}

/**
 * Advances every tracked member's loot eligibility state through every fully-completed day (up
 * to, not including, today) that has at least one event — days with zero events are skipped
 * entirely (neutral), and so is any day covered by one of that member's ACTIVE declared
 * unavailability periods (see db/repositories/vacationRepo.js) — same neutral treatment, just
 * scoped to that one member instead of the whole guild. Only processes days after each member's
 * last_processed_day, so it's a cheap no-op once caught up, but naturally does a full historical
 * backfill the first time it ever runs for a given member (starting from their effective replay
 * start day — see getReplayStart — or the earliest event day, whichever is later).
 */
function processLootEligibility(now = new Date()) {
  const db = getDb();
  const todayStart = startOfUTCDate(now);
  const thresholds = settingsRepo.getLootThresholds();

  const eventDays = db.prepare(
    'SELECT DISTINCT date(start_time) AS day FROM events WHERE start_time < ? ORDER BY day'
  ).all(todayStart.toISOString()).map((r) => r.day);

  if (eventDays.length === 0) {
    logger.debug('Loot eligibility: no fully-completed event days yet, nothing to process');
    return;
  }

  const firstEventDay = eventDays[0];
  const members = lootRepo.getTrackedWithState();

  for (const member of members) {
    const joinedDay = member.joined_at.slice(0, 10);
    const { startDay, initialState } = getReplayStart(joinedDay);
    const neverProcessed = member.last_processed_day === null || member.last_processed_day === undefined;
    const floorDay = startDay > firstEventDay ? startDay : firstEventDay;
    const startAfter = neverProcessed ? dayBefore(floorDay) : member.last_processed_day;
    const excludedDays = vacationRepo.getExcludedDaysForMember(member.member_id);

    const relevantDays = eventDays.filter((d) => d > startAfter && d >= startDay && !excludedDays.has(d));
    if (relevantDays.length === 0) continue;

    const signedDays = new Set(db.prepare(`
      SELECT DISTINCT date(e.start_time) AS day
      FROM signups s JOIN events e ON e.id = s.event_id
      WHERE s.member_id = ? AND e.start_time < ?
    `).all(member.member_id, todayStart.toISOString()).map((r) => r.day));

    // Never processed before: start from this member's effective replay start (see
    // getReplayStart — normally ineligible at their join day, or eligible at the amnesty date).
    let state = neverProcessed
      ? initialState
      : {
        eligible: member.eligible === 1,
        consecutiveMissedDays: member.consecutive_missed_days,
        accumulatedSignedDays: member.accumulated_signed_days,
      };

    let lastDay = startAfter;
    for (const day of relevantDays) {
      state = step(state, signedDays.has(day), thresholds);
      lastDay = day;
    }

    lootRepo.upsertRow(member.member_id, {
      eligible: state.eligible,
      consecutiveMissedDays: state.consecutiveMissedDays,
      accumulatedSignedDays: state.accumulatedSignedDays,
      lastProcessedDay: lastDay,
    });
  }

  logger.info({ processedThrough: eventDays[eventDays.length - 1], memberCount: members.length }, 'Loot eligibility processed');
}

/**
 * Replays a single member's full day-by-day history from their tracked join day through
 * yesterday (read-only — does not touch stored state), for explaining *why* they're in their
 * current eligibility state. Returns every day's outcome plus the day of the most recent state
 * change (eligible flipping either way), so callers can show "what happened recently" rather than
 * a potentially months-long list.
 */
function traceMemberHistory(memberId, now = new Date()) {
  const db = getDb();
  const todayStart = startOfUTCDate(now);
  const thresholds = settingsRepo.getLootThresholds();

  const member = db.prepare('SELECT joined_at FROM members WHERE id = ?').get(memberId);
  if (!member) return null;

  const joinedDay = member.joined_at.slice(0, 10);
  const { startDay, initialState, amnestyApplied } = getReplayStart(joinedDay);

  const excludedDays = vacationRepo.getExcludedDaysForMember(memberId);
  const eventDays = db.prepare(
    'SELECT DISTINCT date(start_time) AS day FROM events WHERE start_time < ? AND date(start_time) >= ? ORDER BY day'
  ).all(todayStart.toISOString(), startDay).map((r) => r.day).filter((d) => !excludedDays.has(d));

  const signedDays = new Set(db.prepare(`
    SELECT DISTINCT date(e.start_time) AS day
    FROM signups s JOIN events e ON e.id = s.event_id
    WHERE s.member_id = ? AND e.start_time < ?
  `).all(memberId, todayStart.toISOString()).map((r) => r.day));

  let state = initialState;
  const trace = [];
  let lastEligibleChangeDay = null; // last day the eligible flag itself flipped, either direction
  let lastResetDay = null; // last day a fresh gap wiped recovery progress (accumulatedSignedDays)
  // back to zero — either the day eligibility was first lost (ineligibleAfterDays) or, if that
  // happened before and the member never regained eligibility since, a later gap while already
  // recovering (recoveryGapDays). This can be more recent than lastEligibleChangeDay: someone can
  // drop once, then have their in-progress recovery wiped again by a second gap without ever
  // having regained eligibility in between — that second wipe is what actually explains their
  // current low progress.

  for (const day of eventDays) {
    const signed = signedDays.has(day);
    const before = state.eligible;
    state = step(state, signed, thresholds);
    if (state.eligible !== before) lastEligibleChangeDay = day;
    // Exact match, not >=: consecutiveMissedDays only ever crosses a given threshold once per
    // streak (it climbs by 1/day), so this catches the day the reset actually happens, not every
    // subsequent day the same ongoing streak continues past it. Which threshold applies depends
    // on whether the member was already eligible entering this day (`before`) — see step() above.
    if (!signed) {
      const resetThreshold = before ? thresholds.ineligibleAfterDays : thresholds.recoveryGapDays + 1;
      if (state.consecutiveMissedDays === resetThreshold) lastResetDay = day;
    }
    trace.push({ day, signed, ...state });
  }

  return {
    joinedDay,
    thresholds,
    trace,
    lastEligibleChangeDay,
    lastResetDay,
    finalState: state,
    amnestyApplied,
    amnestyDate: amnestyApplied ? startDay : null,
  };
}

module.exports = { processLootEligibility, traceMemberHistory, step };
