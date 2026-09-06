const { EmbedBuilder } = require('discord.js');
const { buildDescription } = require('./truncate');

const MAX_TRACE_DAYS = 30; // cap how far back we show, even since the last relevant event

function formatDay(entry) {
  const mark = entry.signed ? '✅ signed' : '❌ missed ';
  const progress = entry.eligible
    ? ''
    : ` (${entry.consecutiveMissedDays > 0 ? `${entry.consecutiveMissedDays} consecutive missed` : `${entry.accumulatedSignedDays} signed toward recovery`})`;
  return `\`${entry.day}\`  ${mark}${progress}`;
}

function buildLootDetailEmbed({
  displayName, avatarUrl, joinedDay, trace, lastEligibleChangeDay, lastResetDay, finalState, thresholds,
}) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: displayName, iconURL: avatarUrl })
    .setTitle('🔍 Loot eligibility — detail')
    .setColor(finalState.eligible ? 0x2ecc71 : 0xe74c3c)
    .setFooter({ text: `Tracked since ${joinedDay} · drops after ${thresholds.ineligibleAfterDays} consecutive missed days, recovers after ${thresholds.recoveryDays} signed days` });

  if (trace.length === 0) {
    embed.setDescription(`No event days have occurred since ${displayName} was tracked (${joinedDay}) yet — nothing to evaluate.`);
    return embed;
  }

  const statusLine = finalState.eligible
    ? '**Status: ✅ Eligible**'
    : `**Status: 🔒 Ineligible** — ${finalState.accumulatedSignedDays}/${thresholds.recoveryDays} days signed toward recovery`;

  const sections = [statusLine];

  // Anchor point for both the narrative and the displayed window: while ineligible, the most
  // recent progress-reset (lastResetDay) is more relevant than the original drop if there have
  // been several gaps since — that reset is what actually explains today's low progress.
  let anchorDay;
  if (finalState.eligible) {
    anchorDay = lastEligibleChangeDay;
    sections.push(`**Last change:** regained eligibility on \`${lastEligibleChangeDay}\` (reached ${thresholds.recoveryDays} signed days).`);
  } else if (lastResetDay) {
    anchorDay = lastResetDay;
    if (lastEligibleChangeDay === null) {
      sections.push(`Never yet reached eligibility since joining — most recent reset on \`${lastResetDay}\` (${thresholds.ineligibleAfterDays} consecutive missed days).`);
    } else if (lastResetDay === lastEligibleChangeDay) {
      sections.push(`**Last change:** dropped to ineligible on \`${lastResetDay}\` (${thresholds.ineligibleAfterDays} consecutive missed days).`);
    } else {
      sections.push(`Originally dropped to ineligible on \`${lastEligibleChangeDay}\`; recovery progress was most recently reset on \`${lastResetDay}\` after another ${thresholds.ineligibleAfterDays}-day gap.`);
    }
  } else {
    // Ineligible, but never yet hit a reset in the visible history — a very new member still
    // accumulating their first few signed days.
    anchorDay = null;
    sections.push('Never yet reached eligibility since joining — showing their full history below.');
  }

  const startIndex = anchorDay === null ? 0 : trace.findIndex((e) => e.day === anchorDay);
  const window = trace.slice(startIndex).slice(-MAX_TRACE_DAYS);
  if (window.length < trace.length - startIndex) {
    sections.push(`*(showing the most recent ${window.length} days)*`);
  }
  sections.push(window.map(formatDay).join('\n'));

  embed.setDescription(buildDescription(sections));
  return embed;
}

module.exports = { buildLootDetailEmbed };
