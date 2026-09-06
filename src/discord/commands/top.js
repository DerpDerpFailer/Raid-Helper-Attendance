const { SlashCommandBuilder } = require('discord.js');
const statsRepo = require('../../db/repositories/statsRepo');
const settingsRepo = require('../../db/repositories/settingsRepo');
const periods = require('../../stats/periods');
const { buildTopFlopEmbed } = require('../embeds/topFlopEmbed');

const AXIS_CHOICES = [
  { name: 'Global score', value: 'global' },
  { name: 'Presence', value: 'presence' },
  { name: 'Sign-up', value: 'response' },
];

const data = new SlashCommandBuilder()
  .setName('top')
  .setDescription('Show the top members for the current period')
  .addStringOption((opt) => opt.setName('axis').setDescription('Ranking axis').addChoices(...AXIS_CHOICES));

async function execute(interaction) {
  const axis = interaction.options.getString('axis') ?? 'global';
  const period = periods.getCurrentPeriod();
  const periodRow = statsRepo.getPeriodByLabel(period.label);

  if (!periodRow) {
    await interaction.reply({ content: 'Stats have not been computed yet for this period. Try `/sync now` first.', ephemeral: true });
    return;
  }

  const size = settingsRepo.getTopFlopSize();
  const rows = statsRepo.getTop(periodRow.id, axis, size);
  const embed = buildTopFlopEmbed({
    kind: 'top', axis, rows, period, size,
  });
  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute, restricted: true };
