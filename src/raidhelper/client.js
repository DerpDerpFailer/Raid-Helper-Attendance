const config = require('../config');
const logger = require('../utils/logger');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Raid-Helper's rate limit isn't documented; hitting it in practice (166-event backfill) showed
// firing requests back-to-back trips it almost immediately. This spaces out every request
// (not just retries) regardless of caller, so backfill/poll/manual sync all stay under it.
const MIN_REQUEST_INTERVAL_MS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown for a non-2xx response; carries the HTTP status so callers can branch on it (e.g. 404). */
class RaidHelperApiError extends Error {
  constructor(status, statusText, path) {
    super(`Raid-Helper API ${status} ${statusText} for ${path}`);
    this.status = status;
  }
}

let lastRequestAt = 0;

async function waitForSlot() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

/** Parses a Retry-After header (seconds, per HTTP spec) into milliseconds. Null if absent/invalid. */
function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  return Number.isNaN(seconds) ? null : seconds * 1000;
}

async function request(path, { auth = false } = {}) {
  const url = `${config.raidHelper.baseUrl}${path}`;
  const headers = auth ? { Authorization: config.raidHelper.apiKey } : {};

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    await waitForSlot();

    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const waitMs = retryAfterMs(res) ?? RETRY_DELAY_MS * 2 * attempt;
        logger.warn({ path, attempt, waitMs }, 'Raid-Helper API rate limit hit, backing off');
        if (attempt < MAX_RETRIES) await sleep(waitMs);
        lastError = new RaidHelperApiError(429, 'Too Many Requests', path);
        continue;
      }
      if (res.status === 404) {
        // Not transient — retrying won't help. Fail fast so callers (e.g. eventSync) can treat
        // it as "this event was deleted on Raid-Helper's side" instead of wasting 3 retries on it.
        throw new RaidHelperApiError(404, 'Not Found', path);
      }
      if (!res.ok) {
        throw new RaidHelperApiError(res.status, res.statusText, path);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err instanceof RaidHelperApiError && err.status === 404) throw err;
      logger.warn({ path, attempt, err: err.message }, 'Raid-Helper API request failed, retrying');
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

/** GET /events/{id} — full event data, including sign-ups. Public, no auth required. */
function getEvent(eventId) {
  return request(`/events/${eventId}`);
}

/**
 * GET /servers/{id}/events — general data of every event on the server. Requires server API key.
 *
 * The response reports `pages`/`currentPage`, implying pagination exists, but the query param to
 * request further pages isn't documented anywhere and has never been observed in practice (every
 * server tested so far returns everything on page 1, regardless of what query params are passed —
 * page size limit is apparently well above 166). Best effort: follows the `page` convention (it
 * matches the response's own `currentPage` field), and loudly warns if the total collected count
 * doesn't match `eventsOverall` — that mismatch is the signal this guess turned out to be wrong,
 * rather than silently dropping events past page 1 forever.
 */
async function getServerEvents(serverId) {
  const first = await request(`/servers/${serverId}/events`, { auth: true });
  const pages = first.pages ?? 1;
  if (pages <= 1 || !Array.isArray(first.postedEvents)) return first;

  const merged = { ...first, postedEvents: [...first.postedEvents] };
  for (let page = 2; page <= pages; page += 1) {
    const next = await request(`/servers/${serverId}/events?page=${page}`, { auth: true });
    merged.postedEvents.push(...(next.postedEvents ?? []));
  }

  if (typeof merged.eventsOverall === 'number' && merged.postedEvents.length !== merged.eventsOverall) {
    logger.warn(
      { expected: merged.eventsOverall, got: merged.postedEvents.length, pages },
      'Paginated server-events fetch did not collect the expected total — the ?page= query param guess may be wrong'
    );
  }

  return merged;
}

/** GET /servers/{id}/scheduledevents — upcoming recurring events. Requires server API key. */
function getScheduledEvents(serverId) {
  return request(`/servers/${serverId}/scheduledevents`, { auth: true });
}

module.exports = { getEvent, getServerEvents, getScheduledEvents, RaidHelperApiError };
