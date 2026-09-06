const { EmbedBuilder } = require('discord.js');
const settingsRepo = require('../../db/repositories/settingsRepo');
const { buildDescription } = require('./truncate');

const MEDALS = ['🥇', '🥈', '🥉'];
const AXIS_LABEL = { global: 'Global Score', presence: 'Presence', response: 'Sign-up', absence: 'Absence' };
const RANK_FIELD = {
  global: 'global_rank', presence: 'presence_rank', response: 'response_rank', absence: 'absence_rank',
};

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function formatRow(row, axis, index) {
  const medal = MEDALS[index] ?? `#${row[RANK_FIELD[axis]]}`;
  if (axis === 'global') {
    return `${medal} **${row.display_name}** — score ${row.score_global.toFixed(2)} (${pct(row.presence_rate)} presence / ${pct(row.response_rate)} sign-up)`;
  }
  if (axis === 'presence') {
    return `${medal} **${row.display_name}** — ${pct(row.presence_rate)} presence`;
  }
  if (axis === 'absence') {
    return `${medal} **${row.display_name}** — ${pct(row.absence_rate)} marked absent (${row.absences}/${row.total_events})`;
  }
  return `${medal} **${row.display_name}** — ${pct(row.response_rate)} sign-up`;
}

function buildTopFlopEmbed({
  kind, axis, rows, period, size = settingsRepo.getTopFlopSize(),
}) {
  const icon = kind === 'top' ? '🏆' : '📉';
  const title = `${icon} ${kind === 'top' ? 'Top' : 'Flop'} ${size} — ${AXIS_LABEL[axis]}`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(kind === 'top' ? 0x2ecc71 : 0xe74c3c)
    .setFooter({ text: `Ranked members only (${settingsRepo.getEligibilityMinDays()}+ days tenure) · Period: ${period.label}` });

  if (rows.length === 0) {
    embed.setDescription('No ranked members yet for this period.');
    return embed;
  }

  const lines = rows.map((r, i) => formatRow(r, axis, kind === 'top' ? i : -1));
  embed.setDescription(buildDescription(lines));
  return embed;
}

module.exports = { buildTopFlopEmbed };
