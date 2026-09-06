const { Events } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');
const { migrate } = require('./db/migrate');
const { createClient } = require('./discord/client');
const { registerMemberEvents } = require('./discord/memberEvents');
const { registerInteractionHandler } = require('./discord/interactionHandler');
const { runBackfill } = require('./sync/backfill');
const { reconcileMembers } = require('./scheduler/reconcileMembers');
const { snapshotStats } = require('./scheduler/snapshotStats');
const { processLootEligibility } = require('./stats/lootEligibility');
const scheduler = require('./scheduler');

async function main() {
  migrate();
  logger.info('Database ready');

  const client = createClient();
  registerMemberEvents(client);
  registerInteractionHandler(client);

  client.once(Events.ClientReady, async () => {
    logger.info({ tag: client.user.tag }, 'Discord bot logged in');

    try {
      await runBackfill();
    } catch (err) {
      logger.error({ err: err.message }, 'Backfill failed, will retry on next manual /sync now');
    }

    // Run once immediately at boot — otherwise a fresh deploy has no stats at all until the
    // next 03:00 UTC cron fires, which could be up to 24h of "not computed yet" for users.
    try {
      const guild = await client.guilds.fetch(config.discord.guildId);
      await reconcileMembers(guild);
      snapshotStats();
      processLootEligibility();
    } catch (err) {
      logger.error({ err: err.message }, 'Initial member reconciliation / stats snapshot / loot processing failed, will retry on next daily cron or manual /sync now');
    }

    scheduler.start(client);
  });

  await client.login(config.discord.token);
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Fatal error during startup');
  process.exit(1);
});
