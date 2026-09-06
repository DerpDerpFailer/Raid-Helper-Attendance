import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = 'test';
process.env.DISCORD_GUILD_ID = 'test';
process.env.RAIDHELPER_API_KEY = 'test';
process.env.RAIDHELPER_SERVER_ID = 'test';
process.env.DB_PATH = ':memory:';

const client = require('../../src/raidhelper/client');
const logger = require('../../src/utils/logger');

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

describe('raidhelper/client getServerEvents pagination', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the response as-is when there is only one page', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      pages: 1, currentPage: 1, eventsOverall: 2, eventsTransmitted: 2, postedEvents: [{ id: '1' }, { id: '2' }],
    }));

    const result = await client.getServerEvents('server1');
    expect(result.postedEvents).toHaveLength(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('follows every page and merges postedEvents together', async () => {
    const calls = [];
    global.fetch = vi.fn().mockImplementation(async (url) => {
      calls.push(url);
      if (url.includes('page=2')) {
        return jsonResponse({
          pages: 2, currentPage: 2, eventsOverall: 5, eventsTransmitted: 5, postedEvents: [{ id: '4' }, { id: '5' }],
        });
      }
      return jsonResponse({
        pages: 2, currentPage: 1, eventsOverall: 5, eventsTransmitted: 5, postedEvents: [{ id: '1' }, { id: '2' }, { id: '3' }],
      });
    });

    const warnSpy = vi.spyOn(logger, 'warn');
    const result = await client.getServerEvents('server1');

    expect(result.postedEvents.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(calls.some((u) => u.includes('page=2'))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('did not collect the expected total'));
  });

  it('warns loudly when the collected total does not match eventsOverall (the page= guess may be wrong)', async () => {
    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('page=2')) {
        // Simulates the guessed query param being ignored: page 2 just re-returns page 1's data.
        return jsonResponse({
          pages: 2, currentPage: 1, eventsOverall: 5, eventsTransmitted: 3, postedEvents: [{ id: '1' }, { id: '2' }, { id: '3' }],
        });
      }
      return jsonResponse({
        pages: 2, currentPage: 1, eventsOverall: 5, eventsTransmitted: 3, postedEvents: [{ id: '1' }, { id: '2' }, { id: '3' }],
      });
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await client.getServerEvents('server1');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ expected: 5, got: 6 }),
      expect.stringContaining('did not collect the expected total')
    );
  });
});
