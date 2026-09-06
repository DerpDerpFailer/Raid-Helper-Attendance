const { SlashCommandBuilder } = require('discord.js');
const lootRepo = require('../../db/repositories/lootRepo');
const settingsRepo = require('../../db/repositories/settingsRepo');
const { processLootEligibility } = require('../../stats/lootEligibility');
const { buildLootIneligibleEmbed, buildLootOverviewEmbed } = require('../embeds/lootEmbed');

const data = new SlashCommandBuilder()
  .setName('eligibility-loot')
  .setDescription('Loot eligibility based on sign-up activity gaps')
  .addStringOption((opt) => opt
    .setName('view')
    .setDescription('What to show')
    .setRequired(true)
    .addChoices(
      { name: 'Ineligible — who currently can\'t loot, with recovery progress', value: 'ineligible' },
      { name: 'All — full overview (eligible + ineligible + not yet evaluated)', value: 'all' },
    ));

async function execute(interaction) {
  const view = interaction.options.getString('view');

  processLootEligibility();
  const rows = lootRepo.getTrackedWithState();
  const thresholds = settingsRepo.getLootThresholds();

  const embed = view === 'all'
    ? buildLootOverviewEmbed({ rows, thresholds })
    : buildLootIneligibleEmbed({ rows, thresholds });

  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute };
