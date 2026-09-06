const client = require('../raidhelper/client');
const config = require('../config');
const eventSync = require('./eventSync');
const { mapServerEventsList } = require('../raidhelper/mapper');
const syncStateRepo = require('../db/repositories/syncStateRepo');
const logger = require('../utils/logger');

const BACKFILL_DONE_KEY = 'backfill_done';

function isBackfillDone() {
  return syncStateRepo.get(BACKFILL_DONE_KEY) === 'true';
}

/** Walks every event ever posted on the server and syncs its full detail. Runs once, at first boot. */
async function runBackfill() {
  if (isBackfillDone()) {
    logger.info('Backfill already completed, skipping');
    return;
  }

  logger.info('Starting backfill of full event history');
  // getServerEvents follows every page automatically (best effort — see its own doc comment for
  // why the query param can't be verified, and the count-mismatch warning it logs if it's wrong).
  const raw = await client.getServerEvents(config.raidHelper.serverId);
  const eventIds = mapServerEventsList(raw).map((e) => e.id);

  logger.info({ count: eventIds.length }, 'Backfilling events');
  const failures = await eventSync.syncEvents(eventIds);

  syncStateRepo.set('last_poll_at', new Date().toISOString());

  if (failures > 0) {
    // Don't mark backfill done: some events (transient API errors, rate limiting, ...) never
    // synced. Idempotent upserts mean it's safe to retry the whole batch again next boot.
    logger.warn({ failures, total: eventIds.length }, 'Backfill finished with failures, will retry on next boot');
    return;
  }

  syncStateRepo.set(BACKFILL_DONE_KEY, 'true');
  logger.info('Backfill complete');
}

module.exports = { runBackfill, isBackfillDone };
