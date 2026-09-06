-- Separates "is this person still a Discord guild member" (is_active, driven only by real
-- join/leave) from "does this person currently hold the monitored role" (is_tracked). Previously
-- a single is_active flag conflated both, so toggling the monitored role (even without ever
-- leaving Discord) reset joined_at and wiped loot-eligibility progress — too fragile, since a
-- role misconfiguration or a bot restart glitch could unfairly penalize veteran members.
-- Default 1 preserves the current visible set until the next reconciliation recomputes it from
-- real role membership.
ALTER TABLE members ADD COLUMN is_tracked INTEGER NOT NULL DEFAULT 1;
