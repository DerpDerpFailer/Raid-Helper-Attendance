const { SlashCommandBuilder } = require('discord.js');
const engine = require('../../stats/engine');
const { buildNoSignupEmbed } = require('../embeds/noSignupEmbed');

const DEFAULT_DAYS = 7;

const data = new SlashCommandBuilder()
  .setName('nosignup')
  .setDescription(`Members with zero sign-ups in the last ${DEFAULT_DAYS} days (any status)`)
  .addIntegerOption((opt) => opt
    .setName('days')
    .setDescription(`Window size in days (default ${DEFAULT_DAYS})`)
    .setMinValue(1)
    .setMaxValue(90));

async function execute(interaction) {
  const days = interaction.options.getInteger('days') ?? DEFAULT_DAYS;
  const { eventsInWindow, members } = engine.getNoSignupMembers(days);
  const embed = buildNoSignupEmbed({ days, eventsInWindow, members });
  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute, restricted: true };
