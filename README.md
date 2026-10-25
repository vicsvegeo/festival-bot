# festival-bot

A Discord bot for Fortnite Festival. It DMs you when a song you follow enters the free rotation (the songs you can play on Main Stage without owning them), again when it has less than a day left, and whenever new Jam Tracks come out.

## Commands

- `/subscribe song:` autocompletes over the whole Jam Track catalog, with 🟢 on songs in the free rotation right now.
- `/catalog [view] [search]` is a paged list (25 per page) with a multi-select to subscribe. Its tabs are All, In rotation and Newest.
- `/subscriptions` lists your songs, each with an unsubscribe button, plus the new-song alerts toggle.
- `/festival-preview` only exists when `FESTIVAL_PREVIEW=1`. It DMs you one of each alert, built from live data, for checking the design.

## DMs

- **Entered rotation**: sent when a subscribed song enters the free rotation. It says how long the song stays and when it leaves, as a Discord timestamp, so it shows in your timezone with a countdown.
- **Last day**: sent once per stint when under 24 hours are left. If Epic extends the stint past 24 hours again, it is re-armed.
- **New Jam Track**: one DM per release drop, with a select menu to subscribe. Anyone who has subscribed to a song gets it, unless they've turned it off in `/subscriptions`.

Every alert has an Unsubscribe button.

## Data

- **Catalog**: Epic's public content API (`fortnite-game/spark-tracks`). The bot checks it every 15 minutes. `_activeDate` is the release date, and tracks it hasn't seen before count as releases. The first run only seeds the list.
- **Rotation with end times**: Fortnite's calendar timeline, using `PilgrimSong.<track>` events with `activeUntil`. It needs an Epic account login, because anonymous tokens lack `fortnite:calendar READ`. This isn't an official Epic API: it logs in the way the Fortnite iOS app does, so use an alt account. Run `npm run epic-login -- <authorizationCode>` once (instructions are in `scripts/epic-login.ts`) and set the printed `EPIC_DEVICE_AUTH`.
- **Fallback rotation**: without `EPIC_DEVICE_AUTH`, or when the timeline fails, the bot reads [fnfestival.co](https://fnfestival.co)'s daily `data/tracks.json`. Tracks whose `lastFeatured` is on the same UTC day as `_metadata.lastUpdated` are in rotation. This source has no end times, so there are no last-day reminders.
- **State**: the bot creates its tables on startup. `festival_subscription` and `festival_release_alert` are keyed by Discord user id. `festival_rotation` and `festival_catalog` hold what it last saw, so restarts don't re-notify.

## Setup

Copy `.env.example` to `.env` and fill it in:

| Variable | Description |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token from the Discord Developer Portal. Invite the bot with the `bot` and `applications.commands` scopes. It can only DM people it shares a server with. |
| `DATABASE_URL` | Postgres connection string. |
| `EPIC_DEVICE_AUTH` | Optional. `accountId:deviceId:secret` from `npm run epic-login`, used for rotation end times. |
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
  epic.ts               Epic device-auth login + calendar timeline reader
scripts/
  epic-login.ts         one-time: authorization code -> EPIC_DEVICE_AUTH
```
