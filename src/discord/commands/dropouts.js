const { SlashCommandBuilder } = require('discord.js');
const statsRepo = require('../../db/repositories/statsRepo');
const periods = require('../../stats/periods');
const { buildDropoutsEmbed } = require('../embeds/alertEmbed');

const data = new SlashCommandBuilder()
  .setName('dropouts')
  .setDescription('Show members whose attendance dropped compared to the previous period');

async function execute(interaction) {
  const period = periods.getCurrentPeriod();
  const previous = periods.getPreviousPeriod(period);
  const periodRow = statsRepo.getPeriodByLabel(period.label);
  const previousPeriodRow = statsRepo.getPeriodByLabel(previous.label);

  if (!periodRow || !previousPeriodRow) {
    await interaction.reply({ content: 'Not enough history yet to compare periods. Try `/sync now` first.', ephemeral: true });
    return;
  }

  const rows = statsRepo.getEvolution(periodRow.id, previousPeriodRow.id);
  const embed = buildDropoutsEmbed({ rows, period });
  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute, restricted: true };
