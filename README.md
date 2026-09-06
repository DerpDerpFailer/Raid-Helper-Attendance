# Raid-Helper Attendance Bot

Discord bot that syncs sign-ups from the Raid-Helper premium API and computes attendance
rankings, individual trends, dropout alerts, and a per-member loot eligibility state for a single
guild.

## How it works

- Polls the Raid-Helper API (`GET /servers/{id}/events`, `GET /events/{id}`) on a schedule and
  stores every event + sign-up locally in SQLite. Only events that have already happened are ever
  counted — an upcoming event can't be held against anyone.
- Tracks guild membership via the Discord gateway. Two things are tracked independently:
  - **Tenure** (`is_active` / `joined_at` / `left_at`) — real Discord presence. Only resets on a
    genuine leave + rejoin.
  - **Visibility** (`is_tracked`) — whether the member currently holds the role configured via
    `/setup` (see below). Gaining/losing that role only shows/hides them in stats; it never
    touches tenure or resets any progress. This is what keeps a role misconfiguration or a bot
    restart glitch from unfairly penalizing a veteran member.
- Computes, once a day (and once at boot, and on `/sync now`), a stats snapshot for the current
  period (week/month/rolling window) and keeps the previous period's snapshot frozen for trend
  comparisons.
- Runs a separate day-by-day state machine per member for loot eligibility: a consecutive-day
  sign-up gap drops it, a run of signed days restores it. See `/eligibility-loot-detail` to see
  the reasoning for one member.
- Every setting has a sensible env-var default (see [`.env.example`](./.env.example)) and can be
  overridden at runtime via `/setup` without a redeploy.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/top axis:<global\|presence\|sign-up>` | everyone | Top 10 ranked members on the chosen axis |
| `/flop axis:<global\|presence\|sign-up\|absence>` | everyone | Bottom 10 on the chosen axis (`absence` = who marks themselves absent most) |
| `/stats [member]` | everyone | One member's rates, ranks, and trend vs. the previous period |
| `/dropouts` | everyone | Members whose Global Score dropped enough to flag Alert/Critical this period |
| `/nosignup [days]` | everyone | Tracked members with zero sign-up (any status) in a rolling N-day window (default 7) |
| `/eligibility-loot view:<ineligible\|all>` | everyone | Loot eligibility list, with recovery progress |
| `/eligibility-loot-detail member:<user>` | everyone | Day-by-day explanation of why one member is (or isn't) loot-eligible |
| `/sync action:<status\|now>` | Manage Server | Inspect sync state, or force an immediate poll + recompute |
| `/setup [...]` | Manage Server | Configure the bot — every option is optional, fill in only what you want to change (see below) |

### `/setup` options

All optional — omit everything to just see the current values.

| Option | Default | Affects |
|---|---|---|
| `role` | none (falls back to "every non-bot member") | Which role marks a real tracked member |
| `score-weight-presence` | 70 (%) | Global Score weighting; sign-up gets the rest |
| `period-mode` | `week` | `week` \| `month` \| `rolling` — cadence for rankings and `/dropouts` |
| `period-rolling-days` | 30 | Window size, only used when `period-mode` is `rolling` |
| `eligibility-min-days` | 14 | Minimum tenure before a member appears in rankings |
| `dropout-alert-rank` / `dropout-alert-score` | 15 / 0.15 | `/dropouts` Alert threshold |
| `dropout-critical-rank` / `dropout-critical-score` | 30 / 0.30 | `/dropouts` Critical threshold |
| `loot-ineligible-after-days` | 3 | Consecutive missed days before loot eligibility drops |
| `loot-recovery-days` | 7 | Signed days needed to (re)gain loot eligibility |

Changes to period/eligibility/loot settings apply on the next `/sync now` or daily recompute, not
retroactively to already-frozen past periods.

## First-time setup

Run `/setup role:<your raider role>` (e.g. "Member") right after deploying. Only members holding
that role are tracked — this is what keeps bots, allies, and guests out of the rankings and loot
list. Without it, the bot falls back to tracking every non-bot guild member, which is rarely what
you want. Follow up with `/sync now` to apply it immediately.

## Local development

```bash
npm install
cp .env.example .env   # fill in the values below
npm run deploy-commands
npm start
```

You need, at minimum:
- A Discord application + bot (Discord Developer Portal): `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`.
  Invite it to your guild with the `applications.commands` and `bot` scopes, and enable the
  **Server Members Intent** in the bot's settings (required for tracking join/leave/role changes).
- `DISCORD_GUILD_ID`: the target guild's id.
- A Raid-Helper server API key: run `/apikey` in your Discord server (requires Raid-Helper
  Premium) to get `RAIDHELPER_API_KEY`, and `RAIDHELPER_SERVER_ID` is your guild id as well.

Run the test suite with `npm test`.

## Deployment: GitHub + Portainer

The bot is not built locally — Portainer builds and runs it directly from this GitHub repo.

1. Push this repo to GitHub.
2. In Portainer: **Stacks → Add stack → Repository**.
   - Repository URL: this repo's URL.
   - Reference: `refs/heads/main` (or your default branch).
   - Compose path: `docker-compose.yml`.
   - If the repo is private, provide a GitHub personal access token (`repo` scope) as the Git
     credentials.
3. In the stack's **Environment variables** section, set every variable listed in
   [`.env.example`](./.env.example) with your real values. Do **not** commit a `.env` file —
   secrets live only in Portainer's stack configuration.
4. Deploy the stack. Portainer clones the repo, builds the image (`Dockerfile`), and starts the
   container with a named volume for the SQLite database.
5. On first boot, the bot runs a full backfill of Raid-Helper's event history before switching
   to incremental polling — this can take a while depending on how many events exist. This also
   applies to the loot eligibility state machine and stats snapshots: they replay the full
   available history the first time they process a given member.

### Redeploying after a `git push`

Pick one, depending on how hands-off you want this:
- **Manual**: click "Pull and redeploy" on the stack in Portainer after every push.
- **Webhook**: enable the stack's redeploy webhook in Portainer and add it as a webhook on the
  GitHub repo (triggers on push).
- **Polling**: Portainer's GitOps polling interval on the stack, if you prefer periodic checks
  over instant webhooks.

Start with the manual option; switch to the webhook once the bot is stable.

## Data model

SQLite, migrated automatically at boot (`migrations/*.sql`, tracked in `schema_migrations`). Core
tables: `members` (roster + tenure + tracked flag), `events` / `signups` (synced from Raid-Helper),
`stats_periods` / `stats_snapshots` (one row per member per computed period), `loot_eligibility`
(one row per member, current state machine values), `settings` (runtime `/setup` overrides).

## Known limitations / things to revisit

- `TOP_FLOP_SIZE` and `POLL_INTERVAL_MINUTES` are still env-var-only (not yet in `/setup`) —
  low-impact, ops-facing settings, deliberately left out for now.
- `/servers/{id}/events` reports `pages`/`currentPage` fields implying pagination exists, but the
  query param to request further pages was never observed/documented — `sync/backfill.js` logs a
  warning if it ever sees more than one page, since only the first would get backfilled.
- The exact Raid-Helper JSON field names (`className` for status, `entryTime` for sign-up
  timestamp, etc. — see `src/raidhelper/mapper.js`) were reverse-engineered from one server's real
  API responses, not from official documentation of the field semantics. They've held up in
  practice, but a future Raid-Helper API change could shift them silently.
