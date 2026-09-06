# Raid-Helper Attendance Bot

[![CI](https://github.com/DerpDerpFailer/Raid-Helper-Attendance/actions/workflows/ci.yml/badge.svg)](https://github.com/DerpDerpFailer/Raid-Helper-Attendance/actions/workflows/ci.yml)

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
| `/stats [member]` | everyone | One member's rates, ranks, and trend vs. the previous period |
| `/top axis:<global\|presence\|sign-up>` | commands-role | Top 10 ranked members on the chosen axis |
| `/flop axis:<global\|presence\|sign-up\|absence>` | commands-role | Bottom 10 on the chosen axis (`absence` = who marks themselves absent most) |
| `/dropouts` | commands-role | Members whose Global Score dropped enough to flag Alert/Critical this period |
| `/nosignup [days]` | commands-role | Tracked members with zero sign-up (any status) in a rolling N-day window (default 7) |
| `/eligibility-loot view:<ineligible\|all>` | commands-role | Loot eligibility list, with recovery progress |
| `/eligibility-loot-detail member:<user>` | commands-role | Day-by-day explanation of why one member is (or isn't) loot-eligible |
| `/sync action:<status\|now>` | Manage Server | Inspect sync state, or force an immediate poll + recompute |
| `/setup [...]` | Manage Server | Configure the bot — every option is optional, fill in only what you want to change (see below) |

### Who can run what

`/stats` is always open to everyone — no configuration needed. Every other command except
`/sync`/`/setup` is gated behind the **commands-role** setting:

- Admins (**Manage Server** permission) can always run every command, regardless of this setting.
- Until an admin sets a role via `/setup commands-role:<role>`, nobody else can run those commands
  at all — this is the safe-by-default starting point.
- Once a role is set, any member holding it can run them too (in addition to admins).

`/sync` and `/setup` are separate: they're gated by Discord's own **Manage Server** permission
directly (not by `commands-role`), so they're always admin-only.

### `/setup` options

All optional — omit everything to just see the current values.

| Option | Default | Affects |
|---|---|---|
| `role` | none (falls back to "every non-bot member") | Which role marks a real tracked member |
| `commands-role` | none (admins only) | Which role, besides admins, may run the bot's reporting commands |
| `score-weight-presence` | 70 (%) | Global Score weighting; sign-up gets the rest |
| `period-mode` | `week` | `week` \| `month` \| `rolling` — cadence for rankings and `/dropouts` |
| `period-rolling-days` | 30 | Window size, only used when `period-mode` is `rolling` |
| `eligibility-min-days` | 14 | Minimum tenure before a member appears in rankings |
| `dropout-alert-rank` / `dropout-alert-score` | 15 / 0.15 | `/dropouts` Alert threshold |
| `dropout-critical-rank` / `dropout-critical-score` | 30 / 0.30 | `/dropouts` Critical threshold |
| `loot-ineligible-after-days` | 3 | Consecutive missed days before loot eligibility drops |
| `loot-recovery-days` | 7 | Signed days needed to (re)gain loot eligibility |
| `top-flop-size` | 10 | Number of entries shown in `/top` and `/flop` |
| `poll-interval-minutes` | 20 | How often the bot polls the Raid-Helper API |

Changes to `role`/period/eligibility/loot settings apply on the next `/sync now` (it reconciles the
member roster first, then recomputes stats and loot) or the next daily recompute — not
retroactively to already-frozen past periods. `poll-interval-minutes` is the one exception — it
reschedules the polling job immediately, no `/sync now` or restart needed.

## First-time setup

Run `/setup role:<your raider role>` (e.g. "Member") right after deploying. Only members holding
that role are tracked — this is what keeps bots, allies, and guests out of the rankings and loot
list. Without it, the bot falls back to tracking every non-bot guild member, which is rarely what
you want. Follow up with `/sync now` to apply it immediately (it re-checks every member's roles
before recomputing anything, so the new tracked-member count reflects the role change right away).

Sanity check: run `/sync status` afterwards and compare "Tracked members" to your actual role
member count in Discord's member list. A mismatch almost always means either the role picked in
`/setup` is wrong, or another instance of the bot is still running somewhere with the same token
(see the warning in the deployment section below) and absorbed the `/setup`/`/sync` commands into
its own separate database instead.

## Local development

```bash
npm install
cp .env.example .env   # fill in the values below
npm start
```

`npm start` registers the slash commands with Discord on every boot, so there's no separate
deploy-commands step. `npm run deploy-commands` still exists standalone if you ever want to
re-register commands without booting the full bot.

You need, at minimum:
- A Discord application + bot (Discord Developer Portal): `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`.
  Invite it to your guild with the `applications.commands` and `bot` scopes, and enable the
  **Server Members Intent** in the bot's settings (required for tracking join/leave/role changes).
- `DISCORD_GUILD_ID`: the target guild's id.
- A Raid-Helper server API key: run `/apikey` in your Discord server (requires Raid-Helper
  Premium) to get `RAIDHELPER_API_KEY`, and `RAIDHELPER_SERVER_ID` is your guild id as well.

Run the test suite with `npm test`. GitHub Actions runs the same thing on every push and pull
request against `main` (`.github/workflows/ci.yml`).

## Deployment: GitHub + Portainer

The bot is not built locally — Portainer builds and runs it directly from this GitHub repo.

> **Run only one instance at a time.** Every instance (your laptop's `docker compose up`, a
> Portainer stack, a second Portainer stack, …) that shares the same `DISCORD_TOKEN` connects to
> Discord as the same bot. Discord then delivers each slash command to only one of the connected
> instances, unpredictably — and each instance has its own independent SQLite volume, so whichever
> one receives a `/setup` change saves it to *its own* database, not the other's. This can look like
> a bug (a setting change that "doesn't take") when it's really just two instances silently
> drifting apart. **Before starting a new instance (e.g. moving from local dev to Portainer, or
> between two hosts), stop every other instance running with the same token first**, either with
> `docker compose down` or by stopping the stack in Portainer.

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

Slash commands are re-registered with Discord automatically on every boot (`src/index.js`), so a
command or option added in a new version shows up after a normal redeploy — no separate manual
step needed.

## Data model

SQLite, migrated automatically at boot (`migrations/*.sql`, tracked in `schema_migrations`). Core
tables: `members` (roster + tenure + tracked flag), `events` / `signups` (synced from Raid-Helper),
`stats_periods` / `stats_snapshots` (one row per member per computed period), `loot_eligibility`
(one row per member, current state machine values), `settings` (runtime `/setup` overrides).

## Known limitations / things to revisit

- `/servers/{id}/events` reports `pages`/`currentPage` fields implying pagination exists, but the
  query param to request further pages isn't documented anywhere, and no server tested so far has
  enough events to actually trigger a second page (page size limit is well above 166). `getServerEvents`
  (`src/raidhelper/client.js`) follows the `page` convention best-effort and logs a loud warning if
  the collected total ever doesn't match `eventsOverall` — that's the signal to revisit this if it
  ever fires.
- The exact Raid-Helper JSON field names (`className` for status, `entryTime` for sign-up
  timestamp, etc. — see `src/raidhelper/mapper.js`) were reverse-engineered from one server's real
  API responses, not from official documentation of the field semantics. They've held up in
  practice, but a future Raid-Helper API change could shift them silently.
