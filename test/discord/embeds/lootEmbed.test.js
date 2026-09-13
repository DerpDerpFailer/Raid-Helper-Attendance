import { describe, it, expect } from 'vitest';

const { buildLootOverviewEmbed, buildLootIneligibleEmbed } = require('../../../src/discord/embeds/lootEmbed');

const THRESHOLDS = { ineligibleAfterDays: 3, recoveryDays: 7, recoveryGapDays: 2 };

const ROWS = [
  {
    member_id: 'alice', display_name: 'Alice', eligible: 1, accumulated_signed_days: 0,
  },
  {
    member_id: 'bob', display_name: 'Bob', eligible: 0, accumulated_signed_days: 4,
  },
  {
    member_id: 'carol', display_name: 'Carol', eligible: null, accumulated_signed_days: 0,
  },
];

describe('discord/embeds/lootEmbed buildLootOverviewEmbed', () => {
  it('buckets eligible/ineligible/pending as before when nobody is on vacation', () => {
    const embed = buildLootOverviewEmbed({ rows: ROWS, thresholds: THRESHOLDS });
    const { description } = embed.data;

    expect(description).toContain('**✅ Eligible (1)**\nAlice');
    expect(description).toContain('**🔒 Ineligible (1)**');
    expect(description).toContain('Bob');
    expect(description).toContain('**⏳ Not yet evaluated (1)**\nCarol');
    expect(description).not.toContain('On vacation');
  });

  it('pulls a vacationing member out of their normal bucket into a dedicated section', () => {
    const onVacation = new Map([
      ['bob', { member_id: 'bob', start_date: '2026-09-14', end_date: '2026-09-18', reason: 'Trip' }],
    ]);
    const embed = buildLootOverviewEmbed({ rows: ROWS, thresholds: THRESHOLDS, onVacation });
    const { description } = embed.data;

    // Bob is no longer listed as ineligible — the section is empty (count 0, "—" placeholder)...
    expect(description).toContain('**🔒 Ineligible (0)**\n—');
    // ...he's in the vacation section instead, with his underlying status, return date, and reason.
    expect(description).toContain('**🌴 On vacation (1)**');
    expect(description).toContain('🔒 **Bob** — back `2026-09-18` (Trip)');
  });

  it('shows the right status emoji for an eligible member on vacation, and omits the reason when none was given', () => {
    const onVacation = new Map([
      ['alice', {
        member_id: 'alice', start_date: '2026-09-14', end_date: '2026-09-15', reason: null,
      }],
    ]);
    const embed = buildLootOverviewEmbed({ rows: ROWS, thresholds: THRESHOLDS, onVacation });

    expect(embed.data.description).toContain('✅ **Alice** — back `2026-09-15`');
    expect(embed.data.description).not.toContain('✅ **Alice** — back `2026-09-15` (');
  });
});

describe('discord/embeds/lootEmbed buildLootIneligibleEmbed', () => {
  it('is unaffected by vacations — still lists a currently-vacationing ineligible member', () => {
    // The ineligible-only view is for loot-management ("who can't loot right now"), so vacation
    // status doesn't hide anyone from it — only the "all" overview gets its own section.
    const embed = buildLootIneligibleEmbed({ rows: ROWS, thresholds: THRESHOLDS });
    expect(embed.data.description).toContain('Bob');
  });
});
