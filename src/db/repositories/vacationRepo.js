const { getDb } = require('../connection');
const { addDays } = require('../../utils/dates');

function getById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM loot_vacations WHERE id = ?').get(id);
}

function create({
  memberId, startDate, endDate, reason,
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO loot_vacations (member_id, start_date, end_date, reason, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)
  `).run(memberId, startDate, endDate, reason || null, now);
  return getById(lastInsertRowid);
}

/** No-op if already cancelled (or the id doesn't exist) — returns the row either way. */
function cancel(id, cancelledBy) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE loot_vacations SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
    WHERE id = ? AND status = 'active'
  `).run(now, cancelledBy, id);
  return getById(id);
}

function nextDay(dayStr) {
  return addDays(new Date(`${dayStr}T00:00:00.000Z`), 1).toISOString().slice(0, 10);
}

/**
 * Every day ('YYYY-MM-DD') covered by any of this member's ACTIVE (non-cancelled) declarations,
 * as a Set — used by stats/lootEligibility.js to skip those days entirely, like a day with zero
 * events. Declarations are capped at MAX_VACATION_DAYS (see vacationInteractions.js) so this Set
 * stays small even with several overlapping or back-to-back declarations.
 */
function getExcludedDaysForMember(memberId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT start_date, end_date FROM loot_vacations WHERE member_id = ? AND status = 'active'
  `).all(memberId);

  const days = new Set();
  for (const row of rows) {
    for (let day = row.start_date; day <= row.end_date; day = nextDay(day)) {
      days.add(day);
    }
  }
  return days;
}

module.exports = {
  create, getById, cancel, getExcludedDaysForMember,
};
