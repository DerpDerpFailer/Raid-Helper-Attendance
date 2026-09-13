const {
  EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder,
} = require('discord.js');

const DECLARE_BUTTON_ID = 'vacation:declare';
const DECLARE_MODAL_ID = 'vacation:declare:submit';

function buildVacationAnnouncementEmbed() {
  return new EmbedBuilder()
    .setTitle('🌴 Going on vacation?')
    .setColor(0x3498db)
    .setDescription(
      "If you're going on vacation or unavailable for a few days, click the button below and "
      + 'fill in your dates and reason. Your loot eligibility won\'t be penalized while you\'re away.'
    );
}

function buildVacationAnnouncementRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(DECLARE_BUTTON_ID)
      .setLabel('Mark unavailable')
      .setEmoji('🌴')
      .setStyle(ButtonStyle.Primary)
  );
}

function buildVacationLogEmbed({
  displayName, avatarUrl, startDate, endDate, reason, cancelled, cancelledBy,
}) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: displayName, iconURL: avatarUrl })
    .setTitle(cancelled ? '🌴 Unavailability — cancelled' : '🌴 Unavailability declared')
    .setColor(cancelled ? 0x95a5a6 : 0xf39c12)
    .addFields(
      { name: 'From', value: `\`${startDate}\``, inline: true },
      { name: 'To', value: `\`${endDate}\``, inline: true }
    );

  if (reason) embed.addFields({ name: 'Reason', value: reason });
  if (cancelled) embed.setFooter({ text: `Cancelled by ${cancelledBy}` });

  return embed;
}

function buildVacationCancelRow(vacationId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vacation:cancel:${vacationId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

module.exports = {
  DECLARE_BUTTON_ID,
  DECLARE_MODAL_ID,
  buildVacationAnnouncementEmbed,
  buildVacationAnnouncementRow,
  buildVacationLogEmbed,
  buildVacationCancelRow,
};
