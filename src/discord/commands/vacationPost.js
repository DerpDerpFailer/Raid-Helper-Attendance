const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { buildVacationAnnouncementEmbed, buildVacationAnnouncementRow } = require('../embeds/vacationEmbed');

const data = new SlashCommandBuilder()
  .setName('vacation-post')
  .setDescription('Admin: post the self-service unavailability announcement + button here')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  await interaction.reply({
    embeds: [buildVacationAnnouncementEmbed()],
    components: [buildVacationAnnouncementRow()],
  });
}

module.exports = { data, execute };
