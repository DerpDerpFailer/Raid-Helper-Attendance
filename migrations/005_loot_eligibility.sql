-- Per-member loot eligibility state machine: 3+ consecutive days with zero sign-up (of any
-- status) drops eligibility; regaining it requires accumulating N signed days (gaps under the
-- threshold don't reset progress, a fresh 3+ day gap does). Days with no events posted at all
-- are neutral and never touched by this table.
CREATE TABLE IF NOT EXISTS loot_eligibility (
  member_id                TEXT PRIMARY KEY REFERENCES members(id),
  eligible                 INTEGER NOT NULL DEFAULT 0,
  consecutive_missed_days  INTEGER NOT NULL DEFAULT 0,
  accumulated_signed_days  INTEGER NOT NULL DEFAULT 0,
  last_processed_day       TEXT, -- 'YYYY-MM-DD' (UTC), NULL until first processed
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
