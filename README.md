# festival-bot

A Discord bot for Fortnite Festival. It DMs you when a song you follow enters the free rotation (the songs you can play on Main Stage without owning them), again when it has less than a day left, and whenever new Jam Tracks come out.

## Commands

- `/subscribe song:` autocompletes over the whole Jam Track catalog, with 🟢 on songs in the free rotation right now.
- `/catalog [view] [search]` is a paged list (25 per page) with a multi-select to subscribe. Its tabs are All, In rotation and Newest.
- `/artists [sort] [search]` lists every artist with their song count and how many are in rotation. Collaborations count toward each credited artist, so "Bad Bunny and Jhayco" counts for both. Picking an artist opens their songs in the catalog view. `/catalog search:artist:<name>` does the same directly.
- `/subscriptions` lists your songs, each with an unsubscribe button, plus the new-song alerts toggle.
- `/link epic:` links your Epic account by display name. Rivalries need it.
- `/rival add player: song: [instrument]` starts a rivalry on one song's all-time board (instrument defaults to Vocals) and shows where you both stand. `/rival list` shows every rivalry with a button to stop each one. Up to 50 per person.
- `/top10k` picks which instruments (any of the 9, or none) go into your weekly top 10,000 summary. Nothing is on by default.
- `/festival-preview` only exists when `FESTIVAL_PREVIEW=1`. It DMs you one of each alert, built from live data, for checking the design.

## DMs

- **Entered rotation**: sent when a subscribed song enters the free rotation. It says how long the song stays and when it leaves, as a Discord timestamp, so it shows in your timezone with a countdown.
- **Last day**: sent once per stint when under 24 hours are left. If Epic extends the stint past 24 hours again, it is re-armed.
- **New Jam Track**: one DM per release drop, with a select menu to subscribe. Anyone who has subscribed to a song gets it, unless they've turned it off in `/subscriptions`.

Every alert has an Unsubscribe button.

- **Rival alert**: the bot checks each rivalry's all-time board hourly and DMs you when your rival goes from at or below your score to above it.
- **Weekly report**: Sundays at 18:00 UTC. It has two sections:
  - **Top 10,000**: every song where your all-time score on a `/top10k` instrument is in the top 10,000, sorted by rank, with ▲/▼ since last week, 🆕 for new entries, and the boards you dropped out of.
  - **Rivalries**: every rivalry board with both ranks and scores, the gap, and the rank change since last week. 🏆 marks a top-10,000 rank.

## Data

- **Catalog**: Epic's public content API (`fortnite-game/spark-tracks`). The bot checks it every 15 minutes. `_activeDate` is the release date, and tracks it hasn't seen before count as releases. The first run only seeds the list.
- **Rotation with end times**: Fortnite's calendar timeline, using `PilgrimSong.<track>` events with `activeUntil`. It needs an Epic account login, because anonymous tokens lack `fortnite:calendar READ`. This isn't an official Epic API: it logs in the way the Fortnite iOS app does, so use an alt account. Run `npm run epic-login -- <authorizationCode>` once (instructions are in `scripts/epic-login.ts`) and set the printed `EPIC_DEVICE_AUTH`.
- **Fallback rotation**: without `EPIC_DEVICE_AUTH`, or when the timeline fails, the bot reads [fnfestival.co](https://fnfestival.co)'s daily `data/tracks.json`. Tracks whose `lastFeatured` is on the same UTC day as `_metadata.lastUpdated` are in rotation. This source has no end times, so there are no last-day reminders.
- **Leaderboards**: Epic's events service, logged in the same way as the timeline. The public pages stop at the top 10,000, so rivalries instead ask for specific accounts' all-time entries (`alltime_<su>_<instrument>`), which come back with exact ranks at any depth. Only boards with a rivalry are queried, one request per song and instrument an hour. For `/top10k` the bot looks up every song once a week, one request per song and picked instrument (batched across everyone who picked it), 0.5 s apart: about 6 minutes per instrument. If a board fails, its last rank is kept rather than reported as a drop. Epic doesn't let one account list another's boards, so a rivalry has to name the song.
- **State**: the bot creates its tables on startup. `festival_subscription` and `festival_release_alert` are keyed by Discord user id. `festival_rotation` and `festival_catalog` hold what it last saw, so restarts don't re-notify. `epic_link`, `rivalry` (last seen scores and ranks, plus last week's ranks) and `rivalry_report` hold the rivalries. `top10k_instrument` holds the `/top10k` picks and `top10k_rank` last week's top 10,000 entries.

## Setup

Copy `.env.example` to `.env` and fill it in:

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token from the Discord Developer Portal. Invite the bot with the `bot` and `applications.commands` scopes. It can only DM people it shares a server with. |
| `DATABASE_URL` | Postgres connection string. |
| `EPIC_DEVICE_AUTH` | Optional. `accountId:deviceId:secret` from `npm run epic-login`, used for rotation end times and rivalries. |
| `EPIC_CLIENT` | Required with `EPIC_DEVICE_AUTH`: the Fortnite iOS game client `clientId:secret`. |

```bash
npm install
npm run dev                                          # needs a reachable DATABASE_URL
docker compose -f docker-compose.local.yml up --build  # or: bot + throwaway Postgres
```

## Deployment

Pushing to `main` builds `ghcr.io/vicsvegeo/festival-bot` (tagged `latest` and the short SHA) with GitHub Actions. `docker-compose.snippet.yml` is the service block for the server. It runs next to Planka and uses a `festival` database on the same Postgres.

## Layout

```
src/
  index.ts              entrypoint: env check, DB check, wires commands and the watcher
  bot.ts                Discord client, Gateway connection/reconnect logging
  db.ts                 Postgres pool
  festival.ts           catalog + rotation polling, release/rotation/last-day DMs, embeds
  festival-commands.ts  /subscribe, /catalog, /subscriptions, their buttons and menus
  rivals.ts             rivalries: tables, hourly overtake check, weekly report DM
  rival-commands.ts     /link, /rival add, /rival list, /top10k and their buttons/menus
  top10k.ts             weekly top 10,000 sweep and its report section
  epic.ts               Epic device-auth login, calendar timeline, leaderboard scores
scripts/
  epic-login.ts         one-time: authorization code -> EPIC_DEVICE_AUTH
```
