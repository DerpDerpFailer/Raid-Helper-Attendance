-- Member-declared unavailability periods that pause loot-eligibility scoring for their duration.
-- A day covered by an ACTIVE (non-cancelled) declaration is skipped entirely for that member in
-- stats/lootEligibility.js — the same treatment a day with zero guild events already gets for
-- everyone, just scoped to one member instead of the whole guild. Declared via a button + modal
-- (see discord/vacationInteractions.js) and logged to the channel set via /setup
-- vacation-log-channel, where a Cancel button (member or admin only) can undo it.
CREATE TABLE IF NOT EXISTS loot_vacations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id    TEXT NOT NULL REFERENCES members(id),
  start_date   TEXT NOT NULL, -- 'YYYY-MM-DD', inclusive
  end_date     TEXT NOT NULL, -- 'YYYY-MM-DD', inclusive
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'active', -- 'active' | 'cancelled'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  cancelled_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_loot_vacations_member ON loot_vacations(member_id);
