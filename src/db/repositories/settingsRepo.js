const { getDb } = require('../connection');
const config = require('../../config');

const MONITORED_ROLE_ID_KEY = 'monitored_role_id';
const SCORE_WEIGHT_PRESENCE_KEY = 'score_weight_presence';
const DEFAULT_PRESENCE_WEIGHT = 0.7;

const PERIOD_MODE_KEY = 'period_mode';
const PERIOD_ROLLING_DAYS_KEY = 'period_rolling_days';
const ELIGIBILITY_MIN_DAYS_KEY = 'eligibility_min_days';

const DROPOUT_ALERT_RANK_KEY = 'dropout_alert_rank';
const DROPOUT_ALERT_SCORE_KEY = 'dropout_alert_score';
const DROPOUT_CRITICAL_RANK_KEY = 'dropout_critical_rank';
const DROPOUT_CRITICAL_SCORE_KEY = 'dropout_critical_score';
const DEFAULT_DROPOUT_THRESHOLDS = {
  alertRank: 15, alertScore: 0.15, criticalRank: 30, criticalScore: 0.30,
};

const LOOT_INELIGIBLE_AFTER_DAYS_KEY = 'loot_ineligible_after_days';
const LOOT_RECOVERY_DAYS_KEY = 'loot_recovery_days';
const DEFAULT_LOOT_THRESHOLDS = { ineligibleAfterDays: 3, recoveryDays: 7 };

const TOP_FLOP_SIZE_KEY = 'top_flop_size';
const POLL_INTERVAL_MINUTES_KEY = 'poll_interval_minutes';

function get(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function set(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

function numberOr(raw, fallback) {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * The role that marks a "real" tracked member (set via /setup role). When unset, the bot falls
 * back to tracking every non-bot guild member — see scheduler/reconcileMembers.js and
 * discord/memberEvents.js.
 */
function getMonitoredRoleId() {
  return get(MONITORED_ROLE_ID_KEY);
}

function setMonitoredRoleId(roleId) {
  set(MONITORED_ROLE_ID_KEY, roleId);
}

/**
 * Global score weighting (set via /setup score-weight), as a fraction 0..1 for presence — the
 * sign-up weight is always its complement, so the two always sum to 1. Defaults to the original
 * 0.7 presence / 0.3 sign-up split carried over from the old Excel model.
 */
function getScoreWeights() {
  const presenceWeight = numberOr(get(SCORE_WEIGHT_PRESENCE_KEY), DEFAULT_PRESENCE_WEIGHT);
  return { presenceWeight, responseWeight: 1 - presenceWeight };
}

/** @param presenceWeight fraction 0..1 (e.g. 0.7 for 70%) */
function setScoreWeights(presenceWeight) {
  set(SCORE_WEIGHT_PRESENCE_KEY, String(presenceWeight));
}

/**
 * Period cadence (set via /setup period). Falls back to the PERIOD_MODE / PERIOD_ROLLING_DAYS
 * env vars (config.js) when never configured at runtime, so a deployment that never touches
 * /setup keeps behaving exactly as before.
 */
function getPeriodMode() {
  return get(PERIOD_MODE_KEY) || config.stats.periodMode;
}

function setPeriodMode(mode) {
  set(PERIOD_MODE_KEY, mode);
}

function getPeriodRollingDays() {
  return numberOr(get(PERIOD_ROLLING_DAYS_KEY), config.stats.periodRollingDays);
}

function setPeriodRollingDays(days) {
  set(PERIOD_ROLLING_DAYS_KEY, String(days));
}

/** Ranking eligibility tenure (set via /setup eligibility). Falls back to ELIGIBILITY_MIN_DAYS. */
function getEligibilityMinDays() {
  return numberOr(get(ELIGIBILITY_MIN_DAYS_KEY), config.stats.eligibilityMinDays);
}

function setEligibilityMinDays(days) {
  set(ELIGIBILITY_MIN_DAYS_KEY, String(days));
}

/**
 * /dropouts alert thresholds (set via /setup dropout-thresholds), as positive numbers — e.g.
 * alertRank: 15 means "a drop of 15+ ranks triggers Alert". Calibrated for the guild's size at
 * the time; worth revisiting if the roster grows or shrinks a lot.
 */
function getDropoutThresholds() {
  return {
    alertRank: numberOr(get(DROPOUT_ALERT_RANK_KEY), DEFAULT_DROPOUT_THRESHOLDS.alertRank),
    alertScore: numberOr(get(DROPOUT_ALERT_SCORE_KEY), DEFAULT_DROPOUT_THRESHOLDS.alertScore),
    criticalRank: numberOr(get(DROPOUT_CRITICAL_RANK_KEY), DEFAULT_DROPOUT_THRESHOLDS.criticalRank),
    criticalScore: numberOr(get(DROPOUT_CRITICAL_SCORE_KEY), DEFAULT_DROPOUT_THRESHOLDS.criticalScore),
  };
}

/** Only overrides the thresholds actually passed in; the rest keep their current value. */
function setDropoutThresholds({
  alertRank, alertScore, criticalRank, criticalScore,
}) {
  if (alertRank !== undefined) set(DROPOUT_ALERT_RANK_KEY, String(alertRank));
  if (alertScore !== undefined) set(DROPOUT_ALERT_SCORE_KEY, String(alertScore));
  if (criticalRank !== undefined) set(DROPOUT_CRITICAL_RANK_KEY, String(criticalRank));
  if (criticalScore !== undefined) set(DROPOUT_CRITICAL_SCORE_KEY, String(criticalScore));
}

/**
 * /eligibility-loot thresholds (set via /setup): ineligibleAfterDays consecutive days with zero
 * sign-up drops eligibility; recoveryDays signed days (gaps under ineligibleAfterDays don't reset
 * progress, a fresh ineligibleAfterDays-long gap does) are needed to regain it.
 */
function getLootThresholds() {
  return {
    ineligibleAfterDays: numberOr(get(LOOT_INELIGIBLE_AFTER_DAYS_KEY), DEFAULT_LOOT_THRESHOLDS.ineligibleAfterDays),
    recoveryDays: numberOr(get(LOOT_RECOVERY_DAYS_KEY), DEFAULT_LOOT_THRESHOLDS.recoveryDays),
  };
}

/** Only overrides the thresholds actually passed in; the rest keep their current value. */
function setLootThresholds({ ineligibleAfterDays, recoveryDays }) {
  if (ineligibleAfterDays !== undefined) set(LOOT_INELIGIBLE_AFTER_DAYS_KEY, String(ineligibleAfterDays));
  if (recoveryDays !== undefined) set(LOOT_RECOVERY_DAYS_KEY, String(recoveryDays));
}

/** Number of entries shown in /top and /flop (set via /setup). Falls back to TOP_FLOP_SIZE. */
function getTopFlopSize() {
  return numberOr(get(TOP_FLOP_SIZE_KEY), config.stats.topFlopSize);
}

function setTopFlopSize(size) {
  set(TOP_FLOP_SIZE_KEY, String(size));
}

/**
 * How often (minutes) the bot polls the Raid-Helper API (set via /setup). Falls back to
 * POLL_INTERVAL_MINUTES. Changing this only takes effect once scheduler.scheduleEventPolling()
 * is called again — see discord/commands/setup.js.
 */
function getPollIntervalMinutes() {
  return numberOr(get(POLL_INTERVAL_MINUTES_KEY), config.sync.pollIntervalMinutes);
}

function setPollIntervalMinutes(minutes) {
  set(POLL_INTERVAL_MINUTES_KEY, String(minutes));
}

module.exports = {
  get,
  set,
  getMonitoredRoleId,
  setMonitoredRoleId,
  getScoreWeights,
  setScoreWeights,
  getPeriodMode,
  setPeriodMode,
  getPeriodRollingDays,
  setPeriodRollingDays,
  getEligibilityMinDays,
  setEligibilityMinDays,
  getDropoutThresholds,
  setDropoutThresholds,
  getLootThresholds,
  setLootThresholds,
  getTopFlopSize,
  setTopFlopSize,
  getPollIntervalMinutes,
  setPollIntervalMinutes,
};
