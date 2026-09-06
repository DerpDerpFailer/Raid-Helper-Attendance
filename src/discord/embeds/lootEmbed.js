const { EmbedBuilder } = require('discord.js');
const { buildDescription } = require('./truncate');

function bucketize(rows) {
  const ineligible = [];
  const eligible = [];
  const pending = [];
  for (const r of rows) {
    if (r.eligible === 1) eligible.push(r);
    else if (r.eligible === 0) ineligible.push(r);
    else pending.push(r); // no loot_eligibility row yet — joined too recently to have been evaluated
  }
  return { ineligible, eligible, pending };
}

function formatIneligible(r, thresholds) {
  return `**${r.display_name}** — ${r.accumulated_signed_days}/${thresholds.recoveryDays} days signed toward recovery`;
}

/** Ineligible members only, with their progress toward the recovery threshold. */
function buildLootIneligibleEmbed({ rows, thresholds }) {
  const { ineligible } = bucketize(rows);

  const embed = new EmbedBuilder()
    .setTitle('🔒 Loot ineligible')
    .setFooter({ text: `Drops after ${thresholds.ineligibleAfterDays} consecutive days with no sign-up · needs ${thresholds.recoveryDays} signed days to recover` });

  if (ineligible.length === 0) {
    embed.setColor(0x2ecc71);
    embed.setDescription('Nobody is currently loot-ineligible 🎉');
    return embed;
  }

  embed.setColor(0xe74c3c);
  const lines = ineligible
    .sort((a, b) => b.accumulated_signed_days - a.accumulated_signed_days)
    .map((r) => formatIneligible(r, thresholds));
  embed.setDescription(buildDescription(lines));
  return embed;
}

/** Full overview: eligible, ineligible (with progress), and not-yet-evaluated members. */
function buildLootOverviewEmbed({ rows, thresholds }) {
  const { ineligible, eligible, pending } = bucketize(rows);

  const embed = new EmbedBuilder()
    .setTitle('🔒 Loot eligibility — full overview')
    .setColor(ineligible.length > 0 ? 0xf39c12 : 0x2ecc71)
    .setFooter({ text: `Drops after ${thresholds.ineligibleAfterDays} consecutive days with no sign-up · needs ${thresholds.recoveryDays} signed days to recover` });

  const sections = [];
  sections.push(`**✅ Eligible (${eligible.length})**\n${eligible.length ? eligible.map((r) => r.display_name).sort((a, b) => a.localeCompare(b)).join(', ') : '—'}`);
  sections.push(`**🔒 Ineligible (${ineligible.length})**\n${ineligible.length ? ineligible.sort((a, b) => b.accumulated_signed_days - a.accumulated_signed_days).map((r) => formatIneligible(r, thresholds)).join('\n') : '—'}`);
  if (pending.length > 0) {
    sections.push(`**⏳ Not yet evaluated (${pending.length})**\n${pending.map((r) => r.display_name).sort((a, b) => a.localeCompare(b)).join(', ')}`);
  }

  embed.setDescription(buildDescription(sections));
  return embed;
}

module.exports = { buildLootIneligibleEmbed, buildLootOverviewEmbed };
