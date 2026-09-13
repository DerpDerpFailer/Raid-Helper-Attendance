import {
  describe, it, expect, beforeAll,
} from 'vitest';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';

const { migrate } = require('../../src/db/migrate');
const { getDb } = require('../../src/db/connection');
const vacationRepo = require('../../src/db/repositories/vacationRepo');

function seedMember(id) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO members (id, display_name, is_active, joined_at, first_seen_at, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
  `).run(id, id, now, now, now);
}

describe('db/repositories/vacationRepo', () => {
  beforeAll(() => {
    migrate();
    seedMember('alice');
    seedMember('bob');
  });

  it('create() persists a declaration as active, retrievable by id', () => {
    const vacation = vacationRepo.create({
      memberId: 'alice', startDate: '2026-09-14', endDate: '2026-09-18', reason: 'Vacation',
    });

    expect(vacation.member_id).toBe('alice');
    expect(vacation.start_date).toBe('2026-09-14');
    expect(vacation.end_date).toBe('2026-09-18');
    expect(vacation.reason).toBe('Vacation');
    expect(vacation.status).toBe('active');

    expect(vacationRepo.getById(vacation.id)).toEqual(vacation);
  });

  it('create() stores a null reason when none was given', () => {
    const vacation = vacationRepo.create({
      memberId: 'alice', startDate: '2026-10-01', endDate: '2026-10-02', reason: null,
    });
    expect(vacation.reason).toBeNull();
  });

  it('getExcludedDaysForMember() expands a single-day declaration to exactly that one day', () => {
    const vacation = vacationRepo.create({
      memberId: 'bob', startDate: '2026-11-05', endDate: '2026-11-05', reason: null,
    });
    const days = vacationRepo.getExcludedDaysForMember('bob');
    expect([...days]).toEqual(['2026-11-05']);

    vacationRepo.cancel(vacation.id, 'test-cleanup');
  });

  it('getExcludedDaysForMember() expands a multi-day range inclusively and unions multiple active declarations', () => {
    seedMember('carol');
    vacationRepo.create({
      memberId: 'carol', startDate: '2026-09-14', endDate: '2026-09-16', reason: null,
    });
    vacationRepo.create({
      memberId: 'carol', startDate: '2026-09-20', endDate: '2026-09-20', reason: null,
    });

    const days = vacationRepo.getExcludedDaysForMember('carol');
    expect([...days].sort()).toEqual([
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-20',
    ]);
  });

  it('cancel() marks a declaration cancelled and it no longer counts toward excluded days', () => {
    seedMember('dave');
    const vacation = vacationRepo.create({
      memberId: 'dave', startDate: '2026-12-01', endDate: '2026-12-03', reason: null,
    });
    expect(vacationRepo.getExcludedDaysForMember('dave').size).toBe(3);

    const cancelled = vacationRepo.cancel(vacation.id, 'AdminName');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelled_by).toBe('AdminName');
    expect(cancelled.cancelled_at).not.toBeNull();

    expect(vacationRepo.getExcludedDaysForMember('dave').size).toBe(0);
  });

  it('cancel() is a no-op if the declaration is already cancelled or does not exist', () => {
    seedMember('eve');
    const vacation = vacationRepo.create({
      memberId: 'eve', startDate: '2026-12-10', endDate: '2026-12-10', reason: null,
    });
    vacationRepo.cancel(vacation.id, 'first-cancel');
    const secondAttempt = vacationRepo.cancel(vacation.id, 'second-cancel');
    expect(secondAttempt.cancelled_by).toBe('first-cancel'); // unchanged, not overwritten

    expect(vacationRepo.cancel(999999, 'nobody')).toBeUndefined();
  });

  it('getExcludedDaysForMember() is scoped per member — one member is unaffected by another\'s declarations', () => {
    seedMember('frank');
    expect(vacationRepo.getExcludedDaysForMember('frank').size).toBe(0);
  });

  describe('getCurrentlyOnVacation() / getCurrentVacationForMember()', () => {
    it('includes a member whose active declaration covers today, excludes one that does not', () => {
      seedMember('grace');
      seedMember('heidi');
      vacationRepo.create({
        memberId: 'grace', startDate: '2026-09-01', endDate: '2026-09-20', reason: 'Away',
      });
      vacationRepo.create({
        memberId: 'heidi', startDate: '2026-01-01', endDate: '2026-01-05', reason: null,
      }); // long over by the "today" used below

      const today = '2026-09-14';
      const onVacation = vacationRepo.getCurrentlyOnVacation(today);
      expect(onVacation.has('grace')).toBe(true);
      expect(onVacation.get('grace')).toMatchObject({ end_date: '2026-09-20', reason: 'Away' });
      expect(onVacation.has('heidi')).toBe(false);

      expect(vacationRepo.getCurrentVacationForMember('grace', today)).toMatchObject({ end_date: '2026-09-20' });
      expect(vacationRepo.getCurrentVacationForMember('heidi', today)).toBeUndefined();
    });

    it('excludes a cancelled declaration even if today falls within its range', () => {
      seedMember('ivan');
      const vacation = vacationRepo.create({
        memberId: 'ivan', startDate: '2026-09-10', endDate: '2026-09-20', reason: null,
      });
      const today = '2026-09-14';
      expect(vacationRepo.getCurrentlyOnVacation(today).has('ivan')).toBe(true);

      vacationRepo.cancel(vacation.id, 'test');
      expect(vacationRepo.getCurrentlyOnVacation(today).has('ivan')).toBe(false);
      expect(vacationRepo.getCurrentVacationForMember('ivan', today)).toBeUndefined();
    });

    it('excludes a member whose declaration does not cover today yet (future) or anymore (past)', () => {
      seedMember('judy');
      vacationRepo.create({
        memberId: 'judy', startDate: '2026-10-01', endDate: '2026-10-05', reason: null,
      }); // future
      const today = '2026-09-14';
      expect(vacationRepo.getCurrentlyOnVacation(today).has('judy')).toBe(false);
    });

    it('when overlapping active declarations exist for one member, picks the one with the furthest end date', () => {
      seedMember('mallory');
      vacationRepo.create({
        memberId: 'mallory', startDate: '2026-09-10', endDate: '2026-09-15', reason: 'First',
      });
      vacationRepo.create({
        memberId: 'mallory', startDate: '2026-09-12', endDate: '2026-09-25', reason: 'Second',
      });

      const result = vacationRepo.getCurrentVacationForMember('mallory', '2026-09-14');
      expect(result.end_date).toBe('2026-09-25');
    });
  });
});
