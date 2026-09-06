const { getDb } = require('../db/connection');
const statsRepo = require('../db/repositories/statsRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const periods = require('./periods');
const logger = require('../utils/logger');

const SNAPSHOT_QUERY = `
WITH base AS (
  -- e.start_time <= @now excludes events still upcoming within the current (live/partial) period:
  -- an event that hasn't happened yet can't count against anyone's denominator, since members
  -- still have time to sign up for it. Frozen past periods are unaffected (their end is already
  -- before @now by construction, so every event in them already satisfies this).
  SELECT m.id AS member_id, m.joined_at, m.is_active, COUNT(e.id) AS total_events
  FROM members m
  JOIN events e
    ON e.start_time >= @periodStart AND e.start_time < @periodEnd
   AND e.start_time <= @now
   AND e.start_time >= m.joined_at
   AND (m.is_active = 1 OR m.left_at IS NULL OR e.start_time <= m.left_at)
  WHERE m.is_bot = 0 AND m.is_tracked = 1
  GROUP BY m.id
),
signed AS (
  SELECT s.member_id,
    COUNT(*) AS responses,
    SUM(s.is_present) AS presences,
    SUM(CASE WHEN s.status = 'Absence' THEN 1 ELSE 0 END) AS absences
  FROM signups s JOIN events e ON e.id = s.event_id
  WHERE e.start_time >= @periodStart AND e.start_time < @periodEnd AND e.start_time <= @now
  GROUP BY s.member_id
),
computed AS (
  SELECT b.member_id, b.joined_at, b.total_events,
    COALESCE(sg.responses, 0) AS responses,
    COALESCE(sg.presences, 0) AS presences,
    COALESCE(sg.absences, 0) AS absences,
    CASE WHEN b.total_events > 0 THEN CAST(COALESCE(sg.responses, 0) AS REAL) / b.total_events ELSE 0 END AS response_rate,
    CASE WHEN b.total_events > 0 THEN CAST(COALESCE(sg.presences, 0) AS REAL) / b.total_events ELSE 0 END AS presence_rate,
    CASE WHEN b.total_events > 0 THEN CAST(COALESCE(sg.absences, 0) AS REAL) / b.total_events ELSE 0 END AS absence_rate,
    -- Tenure as of @now, not @periodEnd: for the current (live) period, periodEnd is still in the
    -- future, and days that haven't happened yet shouldn't count toward eligibility either.
    CASE WHEN b.is_active = 1 AND (julianday(@now) - julianday(b.joined_at)) >= @eligibilityMinDays
         THEN 1 ELSE 0 END AS eligible
  FROM base b LEFT JOIN signed sg ON sg.member_id = b.member_id
),
scored AS (
  -- Weights configurable via /setup score-weight (default 0.7/0.3, the original Excel model);
  -- always sum to 1 (@responseWeight = 1 - @presenceWeight), see settingsRepo.getScoreWeights().
  SELECT *, (@presenceWeight * presence_rate + @responseWeight * response_rate) AS score_global FROM computed
)
SELECT
  member_id, joined_at, total_events, responses, presences, absences,
  response_rate, presence_rate, absence_rate, score_global, eligible,
  CASE WHEN eligible = 1 THEN RANK() OVER (ORDER BY CASE WHEN eligible = 1 THEN score_global END DESC) END AS global_rank,
  CASE WHEN eligible = 1 THEN RANK() OVER (ORDER BY CASE WHEN eligible = 1 THEN presence_rate END DESC) END AS presence_rank,
  CASE WHEN eligible = 1 THEN RANK() OVER (ORDER BY CASE WHEN eligible = 1 THEN response_rate END DESC) END AS response_rank,
  -- Ascending, unlike the other axes: rank 1 = lowest absence_rate = "best" (rarely marks
  -- absent), consistent with rank 1 always meaning "best" on every axis. NULLS LAST is required
  -- here (unlike the DESC axes above) because SQLite's default puts NULLs first in ASC order,
  -- which would otherwise push ineligible members into the low, "best" rank numbers.
  CASE WHEN eligible = 1 THEN RANK() OVER (ORDER BY CASE WHEN eligible = 1 THEN absence_rate END ASC NULLS LAST) END AS absence_rank
FROM scored;
`;

/**
 * Computes per-member stats rows for [periodStart, periodEnd), counting only events that have
 * already happened as of `now` (defaults to the actual current time — overridable for tests).
 * Pure read, no writes.
 */
function computeSnapshotRows(periodStart, periodEnd, now = new Date()) {
  const db = getDb();
  const { presenceWeight, responseWeight } = settingsRepo.getScoreWeights();
  const rows = db.prepare(SNAPSHOT_QUERY).all({
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    now: now.toISOString(),
    eligibilityMinDays: settingsRepo.getEligibilityMinDays(),
    presenceWeight,
    responseWeight,
  });

  return rows.map((r) => ({
    memberId: r.member_id,
    joinedAt: r.joined_at,
    totalEvents: r.total_events,
    responses: r.responses,
    presences: r.presences,
    absences: r.absences,
    responseRate: r.response_rate,
    presenceRate: r.presence_rate,
    absenceRate: r.absence_rate,
    scoreGlobal: r.score_global,
    eligible: r.eligible,
    globalRank: r.global_rank,
    presenceRank: r.presence_rank,
    responseRank: r.response_rank,
    absenceRank: r.absence_rank,
  }));
}

const NO_SIGNUP_QUERY = `
WITH window_events AS (
  -- Only events that have already happened count — an event still upcoming in the window
  -- can't yet be held against anyone (see computeSnapshotRows for the same principle).
  SELECT id FROM events WHERE start_time >= @windowStart AND start_time <= @now
),
tracked AS (
  SELECT id, display_name, joined_at FROM members
  WHERE is_bot = 0 AND is_active = 1 AND is_tracked = 1
    AND (julianday(@now) - julianday(joined_at)) >= @eligibilityMinDays
),
signed_in_window AS (
  SELECT DISTINCT s.member_id FROM signups s
  JOIN window_events e ON e.id = s.event_id
),
last_signup AS (
  SELECT s.member_id, MAX(e.start_time) AS last_signed_event_at
  FROM signups s JOIN events e ON e.id = s.event_id
  WHERE e.start_time <= @now
  GROUP BY s.member_id
)
SELECT t.id AS member_id, t.display_name, ls.last_signed_event_at
FROM tracked t
LEFT JOIN last_signup ls ON ls.member_id = t.id
WHERE t.id NOT IN (SELECT member_id FROM signed_in_window)
ORDER BY t.display_name COLLATE NOCASE;
`;

/**
 * Tracked members (respects /setup role, excludes bots, respects the same eligibility grace
 * period as every other metric) with zero sign-ups of any status in the last `days` days, as of
 * `now`. Ad-hoc: computed live, not tied to the configured PERIOD_MODE or stored in snapshots.
 */
function getNoSignupMembers(days, now = new Date()) {
  const db = getDb();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const eventsInWindow = db.prepare(
    'SELECT COUNT(*) AS n FROM events WHERE start_time >= ? AND start_time <= ?'
  ).get(windowStart.toISOString(), now.toISOString()).n;

  // Nothing happened in the window at all: "no sign-up" would be true of everyone trivially and
  // wouldn't mean anything. Let the caller show "no events yet" instead of a misleading list.
  if (eventsInWindow === 0) {
    return { eventsInWindow, members: [] };
  }

  const members = db.prepare(NO_SIGNUP_QUERY).all({
    windowStart: windowStart.toISOString(),
    now: now.toISOString(),
    eligibilityMinDays: settingsRepo.getEligibilityMinDays(),
  });

  return { eventsInWindow, members };
}

/** Recomputes and persists the snapshot for a given period, returns its period_id. */
function computeAndStorePeriod(period) {
  const periodId = statsRepo.upsertPeriod(period.label, period.start.toISOString(), period.end.toISOString());
  const rows = computeSnapshotRows(period.start, period.end);
  statsRepo.replaceSnapshots(periodId, rows);
  return periodId;
}

/**
 * Ensures both the current (live, always refreshed) and previous (frozen once complete)
 * period snapshots exist. Safe to call as often as needed (e.g. daily cron, or on demand).
 */
function ensureCurrentAndPreviousSnapshots() {
  const current = periods.getCurrentPeriod();
  const previous = periods.getPreviousPeriod(current);

  const currentPeriodId = computeAndStorePeriod(current);
  logger.info({ label: current.label }, 'Recomputed current period snapshot');

  let previousPeriodId;
  const existingPrevious = statsRepo.getPeriodByLabel(previous.label);
  if (existingPrevious) {
    previousPeriodId = existingPrevious.id;
  } else {
    previousPeriodId = computeAndStorePeriod(previous);
    logger.info({ label: previous.label }, 'Computed previous period snapshot (first time seen)');
  }

  return { current, previous, currentPeriodId, previousPeriodId };
}

module.exports = {
  computeSnapshotRows, computeAndStorePeriod, ensureCurrentAndPreviousSnapshots, getNoSignupMembers,
};
