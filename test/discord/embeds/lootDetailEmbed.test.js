import { describe, it, expect } from 'vitest';

const { buildLootDetailEmbed } = require('../../../src/discord/embeds/lootDetailEmbed');

function build(overrides) {
  return buildLootDetailEmbed({
    displayName: 'Test',
    avatarUrl: 'https://example.com/avatar.png',
    joinedDay: '2026-01-01',
    trace: [],
    lastEligibleChangeDay: null,
    lastResetDay: null,
    finalState: { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 0 },
    thresholds: { ineligibleAfterDays: 3, recoveryDays: 7, recoveryGapDays: 2 },
    amnestyApplied: false,
    amnestyDate: null,
    ...overrides,
  });
}

describe('discord/embeds/lootDetailEmbed narrative thresholds', () => {
  it('describes a later reset while already recovering using recoveryGapDays, not ineligibleAfterDays (the DerpyFailer bug)', () => {
    // lastResetDay !== lastEligibleChangeDay: the member dropped once, then had a SECOND gap
    // while already recovering — that second reset is governed by recoveryGapDays (0 here), not
    // the unrelated ineligibleAfterDays (3), so the narrative must say "1-day gap", not "3-day".
    const embed = build({
      trace: [{
        day: '2026-08-30', signed: false, eligible: false, consecutiveMissedDays: 1, accumulatedSignedDays: 0,
      }],
      lastEligibleChangeDay: '2026-07-31',
      lastResetDay: '2026-08-30',
      finalState: { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 6 },
      thresholds: { ineligibleAfterDays: 3, recoveryDays: 7, recoveryGapDays: 0 },
    });

    const { description } = embed.data;
    expect(description).toContain('after another 1-day gap');
    expect(description).not.toContain('after another 3-day gap');
  });

  it('describes the very first drop using ineligibleAfterDays (lastResetDay === lastEligibleChangeDay)', () => {
    const embed = build({
      trace: [{
        day: '2026-08-30', signed: false, eligible: false, consecutiveMissedDays: 3, accumulatedSignedDays: 0,
      }],
      lastEligibleChangeDay: '2026-08-30',
      lastResetDay: '2026-08-30',
      finalState: { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 0 },
      thresholds: { ineligibleAfterDays: 3, recoveryDays: 7, recoveryGapDays: 0 },
    });

    expect(embed.data.description).toContain('dropped to ineligible on `2026-08-30` (3 consecutive missed days)');
  });

  it('describes a reset for a member who never reached eligibility using recoveryGapDays', () => {
    const embed = build({
      trace: [{
        day: '2026-08-30', signed: false, eligible: false, consecutiveMissedDays: 1, accumulatedSignedDays: 0,
      }],
      lastEligibleChangeDay: null,
      lastResetDay: '2026-08-30',
      finalState: { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 0 },
      thresholds: { ineligibleAfterDays: 3, recoveryDays: 7, recoveryGapDays: 0 },
    });

    expect(embed.data.description).toContain('most recent reset on `2026-08-30` (1 consecutive missed day(s))');
  });
});

describe('discord/embeds/lootDetailEmbed loot-amnesty-date narrative', () => {
  it('shows a dedicated message when still eligible since the amnesty, with no drop since (lastEligibleChangeDay null)', () => {
    const embed = build({
      trace: [{
        day: '2026-06-02', signed: true, eligible: true, consecutiveMissedDays: 0, accumulatedSignedDays: 0,
      }],
      lastEligibleChangeDay: null,
      lastResetDay: null,
      finalState: { eligible: true, consecutiveMissedDays: 0, accumulatedSignedDays: 0 },
      amnestyApplied: true,
      amnestyDate: '2026-06-01',
    });

    const { description } = embed.data;
    expect(description).toContain('Eligible since the `2026-06-01` amnesty — no drops since.');
    expect(description).toContain('History before the `2026-06-01` loot amnesty');
  });

  it('still shows the normal drop narrative when amnesty-granted eligibility was later lost', () => {
    const embed = build({
      trace: [{
        day: '2026-06-05', signed: false, eligible: false, consecutiveMissedDays: 3, accumulatedSignedDays: 0,
      }],
      lastEligibleChangeDay: '2026-06-05',
      lastResetDay: '2026-06-05',
      finalState: { eligible: false, consecutiveMissedDays: 0, accumulatedSignedDays: 0 },
      amnestyApplied: true,
      amnestyDate: '2026-06-01',
    });

    const { description } = embed.data;
    expect(description).toContain('History before the `2026-06-01` loot amnesty');
    expect(description).toContain('dropped to ineligible on `2026-06-05` (3 consecutive missed days)');
  });

  it('references the amnesty date instead of the join day when there is no history to evaluate yet', () => {
    const embed = build({
      trace: [],
      amnestyApplied: true,
      amnestyDate: '2026-06-01',
    });

    expect(embed.data.description).toContain('No event days have occurred since the `2026-06-01` loot amnesty yet');
  });
});
