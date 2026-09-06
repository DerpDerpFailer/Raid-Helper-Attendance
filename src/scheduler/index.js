const cron = require('node-cron');
const config = require('../config');
const settingsRepo = require('../db/repositories/settingsRepo');
const logger = require('../utils/logger');
const { pollEvents } = require('./pollEvents');
const { reconcileMembers } = require('./reconcileMembers');
const { snapshotStats } = require('./snapshotStats');
const { processLootEligibility } = require('../stats/lootEligibility');

function safeRun(name, fn) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ job: name, err: err.message }, 'Scheduled job failed');
    }
  };
}

let pollTask = null;

/**
 * (Re)schedules the event-polling cron job at the currently configured interval (/setup, falls
 * back to POLL_INTERVAL_MINUTES). Safe to call again after the interval changes — stops the
 * previous schedule first, so a runtime change via /setup takes effect immediately instead of
 * requiring a restart.
 */
function scheduleEventPolling() {
  if (pollTask) pollTask.stop();

  const minutes = settingsRepo.getPollIntervalMinutes();
  pollTask = cron.schedule(`*/${minutes} * * * *`, safeRun('pollEvents', pollEvents));
  logger.info({ everyMinutes: minutes }, 'Scheduled event polling');
}

/** Wires up every recurring job. Must be called once, after the Discord client is ready. */
function start(client) {
  scheduleEventPolling();

  // Daily at 03:00 UTC: reconcile roster, then recompute stats snapshots.
  cron.schedule('0 3 * * *', safeRun('reconcileMembers', async () => {
    const guild = await client.guilds.fetch(config.discord.guildId);
    await reconcileMembers(guild);
  }));

  cron.schedule('5 3 * * *', safeRun('snapshotStats', snapshotStats));
  cron.schedule('10 3 * * *', safeRun('processLootEligibility', processLootEligibility));
  logger.info('Scheduled daily member reconciliation, stats snapshot, and loot eligibility processing');
}

module.exports = { start, scheduleEventPolling };
