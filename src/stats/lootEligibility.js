const { getDb } = require('../db/connection');
const lootRepo = require('../db/repositories/lootRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
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
 *  - Not signed: consecutive-missed grows. Hitting `ineligibleAfterDays` drops eligibility (if
 *    not already dropped) AND wipes any in-progress recovery (if already ineligible) — a fresh
 *    gap that long resets the recovery clock even though the member was already ineligible.
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
    if (consecutiveMissedDays >= thresholds.ineligibleAfterDays) {
      eligible = false;
      accumulatedSignedDays = 0;
    }
  }

  return { eligible, consecutiveMissedDays, accumulatedSignedDays };
}

/**
 * Advances every tracked member's loot eligibility state through every fully-completed day (up
 * to, not including, today) that has at least one event — days with zero events are skipped
 * entirely (neutral). Only processes days after each member's last_processed_day, so it's a cheap
 * no-op once caught up, but naturally does a full historical backfill the first time it ever runs
 * for a given member (starting from their tracked join day or the earliest event day, whichever
 * is later).
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
    const neverProcessed = member.last_processed_day === null || member.last_processed_day === undefined;
    const floorDay = joinedDay > firstEventDay ? joinedDay : firstEventDay;
    const startAfter = neverProcessed ? dayBefore(floorDay) : member.last_processed_day;

    const relevantDays = eventDays.filter((d) => d > startAfter && d >= joinedDay);
    if (relevantDays.length === 0) continue;

    const signedDays = new Set(db.prepare(`
      SELECT DISTINCT date(e.start_time) AS day
      FROM signups s JOIN events e ON e.id = s.event_id
      WHERE s.member_id = ? AND e.start_time < ?
    `).all(member.member_id, todayStart.toISOString()).map((r) => r.day));

    // Never processed before: start as ineligible with zero progress — a member earns initial
    // eligibility the same way anyone recovering does, per the confirmed rule.
    let state = neverProcessed
      ? { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 0 }
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

module.exports = { processLootEligibility, step };
