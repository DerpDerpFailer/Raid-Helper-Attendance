const { getDb } = require('../connection');

function getRow(memberId) {
  const db = getDb();
  return db.prepare('SELECT * FROM loot_eligibility WHERE member_id = ?').get(memberId);
}

function upsertRow(memberId, {
  eligible, consecutiveMissedDays, accumulatedSignedDays, lastProcessedDay,
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO loot_eligibility (
      member_id, eligible, consecutive_missed_days, accumulated_signed_days, last_processed_day, updated_at
    ) VALUES (@memberId, @eligible, @consecutiveMissedDays, @accumulatedSignedDays, @lastProcessedDay, @now)
    ON CONFLICT(member_id) DO UPDATE SET
      eligible = excluded.eligible,
      consecutive_missed_days = excluded.consecutive_missed_days,
      accumulated_signed_days = excluded.accumulated_signed_days,
      last_processed_day = excluded.last_processed_day,
      updated_at = excluded.updated_at
  `).run({
    memberId,
    eligible: eligible ? 1 : 0,
    consecutiveMissedDays,
    accumulatedSignedDays,
    lastProcessedDay,
    now: new Date().toISOString(),
  });
}

/** Tracked members (respects /setup role, excludes bots) joined with their current loot state, if any. */
function getTrackedWithState() {
  const db = getDb();
  return db.prepare(`
    SELECT m.id AS member_id, m.display_name, m.joined_at,
      le.eligible, le.consecutive_missed_days, le.accumulated_signed_days, le.last_processed_day
    FROM members m
    LEFT JOIN loot_eligibility le ON le.member_id = m.id
    WHERE m.is_bot = 0 AND m.is_active = 1 AND m.is_tracked = 1
  `).all();
}

module.exports = {
  getRow, upsertRow, getTrackedWithState,
};
