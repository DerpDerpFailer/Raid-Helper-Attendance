const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const settingsRepo = require('../../db/repositories/settingsRepo');
const scheduler = require('../../scheduler');

const PERIOD_MODE_CHOICES = [
  { name: 'Week (Monday-Sunday)', value: 'week' },
  { name: 'Calendar month', value: 'month' },
  { name: 'Rolling N-day window', value: 'rolling' },
];

const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Admin: configure the bot — fill in only the setting(s) you want to change')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addRoleOption((opt) => opt
    .setName('role')
    .setDescription('Which role marks a real tracked member (excludes bots, allies, guests)'))
  .addIntegerOption((opt) => opt
    .setName('score-weight-presence')
    .setDescription('Global Score: presence weight in %, sign-up gets the rest (default 70)')
    .setMinValue(0)
    .setMaxValue(100))
  .addStringOption((opt) => opt
    .setName('period-mode')
    .setDescription('Cadence used for rankings and /dropouts comparisons (default: week)')
    .addChoices(...PERIOD_MODE_CHOICES))
  .addIntegerOption((opt) => opt
    .setName('period-rolling-days')
    .setDescription('Window size in days — only used when period-mode is "Rolling" (default 30)')
    .setMinValue(1)
    .setMaxValue(365))
  .addIntegerOption((opt) => opt
    .setName('eligibility-min-days')
    .setDescription('Minimum days of tenure before a member appears in rankings (default 14)')
    .setMinValue(0)
    .setMaxValue(365))
  .addIntegerOption((opt) => opt
    .setName('dropout-alert-rank')
    .setDescription('/dropouts: rank drop that triggers Alert (default 15)')
    .setMinValue(1))
  .addNumberOption((opt) => opt
    .setName('dropout-alert-score')
    .setDescription('/dropouts: score drop that triggers Alert, 0-1 (default 0.15)')
    .setMinValue(0)
    .setMaxValue(1))
  .addIntegerOption((opt) => opt
    .setName('dropout-critical-rank')
    .setDescription('/dropouts: rank drop that triggers Critical (default 30)')
    .setMinValue(1))
  .addNumberOption((opt) => opt
    .setName('dropout-critical-score')
    .setDescription('/dropouts: score drop that triggers Critical, 0-1 (default 0.30)')
    .setMinValue(0)
    .setMaxValue(1))
  .addIntegerOption((opt) => opt
    .setName('loot-ineligible-after-days')
    .setDescription('/loot: consecutive days with zero sign-up before dropping eligibility (default 3)')
    .setMinValue(1)
    .setMaxValue(60))
  .addIntegerOption((opt) => opt
    .setName('loot-recovery-days')
    .setDescription('/loot: signed days needed to regain eligibility (default 7)')
    .setMinValue(1)
    .setMaxValue(60))
  .addIntegerOption((opt) => opt
    .setName('top-flop-size')
    .setDescription('Number of entries shown in /top and /flop (default 10)')
    .setMinValue(1)
    .setMaxValue(25))
  .addIntegerOption((opt) => opt
    .setName('poll-interval-minutes')
    .setDescription('How often (minutes) the bot polls the Raid-Helper API (default 20)')
    .setMinValue(1)
    .setMaxValue(59));

async function execute(interaction) {
  const changes = [];

  const role = interaction.options.getRole('role');
  if (role !== null) {
    settingsRepo.setMonitoredRoleId(role.id);
    changes.push(`Tracked-member role → **${role.name}**`);
  }

  const presencePercent = interaction.options.getInteger('score-weight-presence');
  if (presencePercent !== null) {
    settingsRepo.setScoreWeights(presencePercent / 100);
    changes.push(`Global Score weighting → **${presencePercent}% presence / ${100 - presencePercent}% sign-up**`);
  }

  const periodMode = interaction.options.getString('period-mode');
  if (periodMode !== null) {
    settingsRepo.setPeriodMode(periodMode);
    changes.push(`Period cadence → **${periodMode}**`);
  }

  const periodRollingDays = interaction.options.getInteger('period-rolling-days');
  if (periodRollingDays !== null) {
    settingsRepo.setPeriodRollingDays(periodRollingDays);
    changes.push(`Rolling window size → **${periodRollingDays} days**`);
  }

  const eligibilityMinDays = interaction.options.getInteger('eligibility-min-days');
  if (eligibilityMinDays !== null) {
    settingsRepo.setEligibilityMinDays(eligibilityMinDays);
    changes.push(`Ranking eligibility → **${eligibilityMinDays}+ days tenure**`);
  }

  const dropoutOverrides = {
    alertRank: interaction.options.getInteger('dropout-alert-rank') ?? undefined,
    alertScore: interaction.options.getNumber('dropout-alert-score') ?? undefined,
    criticalRank: interaction.options.getInteger('dropout-critical-rank') ?? undefined,
    criticalScore: interaction.options.getNumber('dropout-critical-score') ?? undefined,
  };
  const dropoutChanged = Object.values(dropoutOverrides).some((v) => v !== undefined);
  if (dropoutChanged) {
    settingsRepo.setDropoutThresholds(dropoutOverrides);
    changes.push('Dropout thresholds updated');
  }

  const lootOverrides = {
    ineligibleAfterDays: interaction.options.getInteger('loot-ineligible-after-days') ?? undefined,
    recoveryDays: interaction.options.getInteger('loot-recovery-days') ?? undefined,
  };
  const lootChanged = Object.values(lootOverrides).some((v) => v !== undefined);
  if (lootChanged) {
    settingsRepo.setLootThresholds(lootOverrides);
    changes.push('Loot eligibility thresholds updated');
  }

  const topFlopSize = interaction.options.getInteger('top-flop-size');
  if (topFlopSize !== null) {
    settingsRepo.setTopFlopSize(topFlopSize);
    changes.push(`/top and /flop size → **${topFlopSize}**`);
  }

  const pollIntervalMinutes = interaction.options.getInteger('poll-interval-minutes');
  if (pollIntervalMinutes !== null) {
    settingsRepo.setPollIntervalMinutes(pollIntervalMinutes);
    scheduler.scheduleEventPolling(); // takes effect immediately, no restart/`/sync now` needed
    changes.push(`Poll interval → **every ${pollIntervalMinutes} minutes** (already rescheduled)`);
  }

  const t = settingsRepo.getDropoutThresholds();
  const lt = settingsRepo.getLootThresholds();
  const currentSummary = [
    `Period cadence: **${settingsRepo.getPeriodMode()}**${settingsRepo.getPeriodMode() === 'rolling' ? ` (${settingsRepo.getPeriodRollingDays()}d)` : ''}`,
    `Ranking eligibility: **${settingsRepo.getEligibilityMinDays()}+ days**`,
    `Dropout thresholds — Alert: rank ≥${t.alertRank} or score ≥${t.alertScore}, Critical: rank ≥${t.criticalRank} or score ≥${t.criticalScore}`,
    `Loot eligibility — drops after ${lt.ineligibleAfterDays} consecutive missed days, recovers after ${lt.recoveryDays} signed days`,
    `/top and /flop size: **${settingsRepo.getTopFlopSize()}**`,
    `Poll interval: **every ${settingsRepo.getPollIntervalMinutes()} minutes**`,
  ];

  const lines = changes.length > 0
    ? ['Updated:', ...changes, '', 'Run `/sync now` to apply immediately.', '', 'Current settings:', ...currentSummary]
    : ['Nothing changed — no options were provided. Current settings:', ...currentSummary];

  await interaction.reply({ ephemeral: true, content: lines.join('\n') });
}

module.exports = { data, execute };
