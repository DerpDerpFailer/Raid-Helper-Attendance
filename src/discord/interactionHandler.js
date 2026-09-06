const logger = require('../utils/logger');
const { commands } = require('./commands');
const { hasCommandsAccess } = require('./permissions');

function registerInteractionHandler(client) {
  const byName = new Map(commands.map((c) => [c.data.name, c]));

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = byName.get(interaction.commandName);
    if (!command) return;

    if (command.restricted && !hasCommandsAccess(interaction)) {
      await interaction.reply({
        content: "You don't have permission to use this command. Ask an admin to grant it via `/setup commands-role`.",
        ephemeral: true,
      });
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error({ command: interaction.commandName, err: err.message }, 'Command execution failed');
      const payload = { content: 'Something went wrong running this command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  });
}

module.exports = { registerInteractionHandler };
