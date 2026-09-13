const {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, PermissionFlagsBits,
} = require('discord.js');
const vacationRepo = require('../db/repositories/vacationRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const lootRepo = require('../db/repositories/lootRepo');
const membersRepo = require('../db/repositories/membersRepo');
const { processLootEligibility } = require('../stats/lootEligibility');
const {
  DECLARE_BUTTON_ID, DECLARE_MODAL_ID, buildVacationLogEmbed, buildVacationCancelRow,
} = require('./embeds/vacationEmbed');
const logger = require('../utils/logger');

const MAX_VACATION_DAYS = 14;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function isValidDate(value) {
  if (!DATE_RE.test(value)) return false;
  // Date.UTC silently rolls over out-of-range components (e.g. Feb 30 -> Mar 2) instead of
  // rejecting them, so round-trip the parsed components to catch a real calendar date.
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Inclusive day count between two 'YYYY-MM-DD' strings already known to be valid dates. */
function dayCount(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  return Math.round((end - start) / DAY_MS) + 1;
}

/** Re-derives everyone's loot state immediately, instead of waiting for the next /sync now. */
function reprocessLootEligibility() {
  lootRepo.resetProcessingState();
  try {
    processLootEligibility();
  } catch (err) {
    logger.error({ err: err.message }, 'processLootEligibility failed after a vacation change');
  }
}

async function handleDeclareButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId(DECLARE_MODAL_ID)
    .setTitle('Declare unavailability');

  const startInput = new TextInputBuilder()
    .setCustomId('start_date')
    .setLabel('Start date (YYYY-MM-DD)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('2026-09-14')
    .setRequired(true);

  const endInput = new TextInputBuilder()
    .setCustomId('end_date')
    .setLabel('End date (YYYY-MM-DD)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('2026-09-18')
    .setRequired(true);

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Reason (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(endInput),
    new ActionRowBuilder().addComponents(reasonInput)
  );

  await interaction.showModal(modal);
}

async function handleDeclareSubmit(interaction) {
  const startDate = interaction.fields.getTextInputValue('start_date').trim();
  const endDate = interaction.fields.getTextInputValue('end_date').trim();
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;

  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    await interaction.reply({ ephemeral: true, content: 'Invalid date(s) — use `YYYY-MM-DD` for both the start and end date.' });
    return;
  }
  if (endDate < startDate) {
    await interaction.reply({ ephemeral: true, content: 'The end date must be on or after the start date.' });
    return;
  }
  const days = dayCount(startDate, endDate);
  if (days > MAX_VACATION_DAYS) {
    await interaction.reply({ ephemeral: true, content: `That's ${days} days — the maximum is ${MAX_VACATION_DAYS} days per declaration.` });
    return;
  }

  // loot_vacations.member_id is a foreign key — guard against the rare case of a member row not
  // existing yet (e.g. clicking within moments of joining, before reconciliation catches up).
  membersRepo.ensureExists(interaction.user.id, interaction.member?.displayName ?? interaction.user.username);

  const vacation = vacationRepo.create({
    memberId: interaction.user.id, startDate, endDate, reason,
  });

  reprocessLootEligibility();

  await interaction.reply({
    ephemeral: true,
    content: `Recorded — you're marked unavailable from \`${startDate}\` to \`${endDate}\`. Your loot eligibility won't be penalized for those days.`,
  });

  const channelId = settingsRepo.getVacationLogChannelId();
  if (!channelId) {
    logger.warn('Vacation declared but no vacation-log-channel is configured — skipping the log post');
    return;
  }

  const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    logger.warn({ channelId }, 'Configured vacation-log-channel could not be fetched');
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const displayName = member?.displayName ?? interaction.user.username;

  await channel.send({
    embeds: [buildVacationLogEmbed({
      displayName, avatarUrl: interaction.user.displayAvatarURL(), startDate, endDate, reason,
    })],
    components: [buildVacationCancelRow(vacation.id)],
  });
}

async function handleCancelButton(interaction, vacationId) {
  const vacation = vacationRepo.getById(vacationId);
  if (!vacation) {
    await interaction.reply({ ephemeral: true, content: 'This declaration no longer exists.' });
    return;
  }
  if (vacation.status !== 'active') {
    await interaction.reply({ ephemeral: true, content: 'This declaration was already cancelled.' });
    return;
  }

  const isOwner = interaction.user.id === vacation.member_id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!isOwner && !isAdmin) {
    await interaction.reply({ ephemeral: true, content: "You don't have permission to cancel this — only the member themselves or an admin can." });
    return;
  }

  const cancelledBy = interaction.member?.displayName ?? interaction.user.username;
  vacationRepo.cancel(vacationId, cancelledBy);
  reprocessLootEligibility();

  const member = await interaction.guild.members.fetch(vacation.member_id).catch(() => null);
  const displayName = member?.displayName ?? vacation.member_id;

  await interaction.update({
    embeds: [buildVacationLogEmbed({
      displayName,
      avatarUrl: member?.displayAvatarURL?.(),
      startDate: vacation.start_date,
      endDate: vacation.end_date,
      reason: vacation.reason,
      cancelled: true,
      cancelledBy,
    })],
    components: [buildVacationCancelRow(vacationId, true)],
  });
}

/** Returns true if this interaction was ours to handle (caller should stop routing it further). */
async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    if (interaction.customId === DECLARE_BUTTON_ID) {
      await handleDeclareButton(interaction);
      return true;
    }
    if (interaction.customId.startsWith('vacation:cancel:')) {
      const vacationId = Number(interaction.customId.split(':')[2]);
      await handleCancelButton(interaction, vacationId);
      return true;
    }
    return false;
  }

  if (interaction.isModalSubmit() && interaction.customId === DECLARE_MODAL_ID) {
    await handleDeclareSubmit(interaction);
    return true;
  }

  return false;
}

module.exports = { handleInteraction, isValidDate, dayCount, MAX_VACATION_DAYS };
