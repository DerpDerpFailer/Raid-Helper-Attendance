const { SlashCommandBuilder } = require('discord.js');
const { traceMemberHistory } = require('../../stats/lootEligibility');
const { buildLootDetailEmbed } = require('../embeds/lootDetailEmbed');

const data = new SlashCommandBuilder()
  .setName('eligibility-loot-detail')
  .setDescription('Explain exactly why a member is (or isn\'t) loot-eligible, day by day')
  .addUserOption((opt) => opt
    .setName('member')
    .setDescription('Member to look up')
    .setRequired(true));

async function execute(interaction) {
  const targetUser = interaction.options.getUser('member');
  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  const displayName = targetMember?.displayName ?? targetUser.username;

  const result = traceMemberHistory(targetUser.id);
  if (!result) {
    await interaction.reply({ content: `${displayName} isn't tracked yet — no loot eligibility data to show.`, ephemeral: true });
    return;
  }

  const embed = buildLootDetailEmbed({
    displayName,
    avatarUrl: targetUser.displayAvatarURL(),
    ...result,
  });
  await interaction.reply({ embeds: [embed] });
}

module.exports = { data, execute, restricted: true };
