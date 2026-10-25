import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, EmbedBuilder } from "discord.js";
import { getPool } from "./db.js";
import { type BoardScore, type EpicAccount, fetchAllTimeScores, INSTRUMENTS, type Instrument, isEpicConfigured } from "./epic.js";
import { getTrack, type Track } from "./festival.js";
import { buildTop10kEmbeds, clearTop10kRanks, ensureTop10kTables, saveTop10k, sweepTop10k, TOP_BOARD_SIZE } from "./top10k.js";

// Rivalries: "tell me when <Epic player> passes my all-time score on <song>
// on <instrument>", plus a weekly report of every rivalry board. Only the
// registered boards are ever queried.

const CHECK_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
// Weekly report: Sundays at 18:00 UTC.
const REPORT_DAY = 0;
const REPORT_HOUR_UTC = 18;

const RIVAL_COLOR = 0xff4d6d;
const REPORT_COLOR = 0x5b8cff;
export const RIVAL_REMOVE_PREFIX = "festrivalrm";

export interface EpicLink {
  discordUserId: string;
  accountId: string;
  displayName: string;
}

export interface Rivalry {
  id: number;
  discordUserId: string;
  rivalAccountId: string;
  rivalName: string;
  trackId: string;
  instrument: Instrument;
  myScore: number | null;
  rivalScore: number | null;
  myRank: number | null;
  rivalRank: number | null;
  weekMyRank: number | null;
  weekRivalRank: number | null;
  checkedAt: Date | null;
}

export async function ensureRivalTables(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS epic_link (
      discord_user_id text PRIMARY KEY,
      epic_account_id text NOT NULL,
      epic_display_name text NOT NULL,
      linked_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS rivalry (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL,
      rival_account_id text NOT NULL,
      rival_display_name text NOT NULL,
      track_id text NOT NULL,
      instrument text NOT NULL,
      -- standings at the last hourly check (null: no score yet)
      my_score integer,
      rival_score integer,
      my_rank integer,
      rival_rank integer,
      checked_at timestamptz,
      -- ranks at the last weekly report, for the week-over-week change
      week_my_rank integer,
      week_rival_rank integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (discord_user_id, rival_account_id, track_id, instrument)
    );
    CREATE TABLE IF NOT EXISTS rivalry_report (
      discord_user_id text PRIMARY KEY,
      sent_at timestamptz NOT NULL
    );
  `);
}

function toRivalry(row: Record<string, unknown>): Rivalry {
  return {
    id: row.id as number,
    discordUserId: row.discord_user_id as string,
    rivalAccountId: row.rival_account_id as string,
    rivalName: row.rival_display_name as string,
    trackId: row.track_id as string,
    instrument: row.instrument as Instrument,
    myScore: row.my_score as number | null,
    rivalScore: row.rival_score as number | null,
    myRank: row.my_rank as number | null,
    rivalRank: row.rival_rank as number | null,
    weekMyRank: row.week_my_rank as number | null,
    weekRivalRank: row.week_rival_rank as number | null,
    checkedAt: row.checked_at as Date | null,
  };
}

export async function getLink(discordUserId: string): Promise<EpicLink | undefined> {
  const result = await getPool().query("SELECT * FROM epic_link WHERE discord_user_id = $1", [discordUserId]);
  const row = result.rows[0];
  return row
    ? { discordUserId, accountId: row.epic_account_id, displayName: row.epic_display_name }
    : undefined;
}

// Linking a different account clears the stored standings, so the next check
// re-seeds them instead of comparing scores from two different players.
export async function setLink(discordUserId: string, account: EpicAccount): Promise<void> {
  const pool = getPool();
  const previous = await getLink(discordUserId);
  await pool.query(
    `INSERT INTO epic_link (discord_user_id, epic_account_id, epic_display_name) VALUES ($1, $2, $3)
     ON CONFLICT (discord_user_id) DO UPDATE
       SET epic_account_id = excluded.epic_account_id, epic_display_name = excluded.epic_display_name, linked_at = now()`,
    [discordUserId, account.id, account.displayName],
  );
  if (previous && previous.accountId !== account.id) {
    await pool.query(
      `UPDATE rivalry SET my_score = NULL, rival_score = NULL, my_rank = NULL, rival_rank = NULL,
         checked_at = NULL, week_my_rank = NULL, week_rival_rank = NULL
       WHERE discord_user_id = $1`,
      [discordUserId],
    );
    await clearTop10kRanks(discordUserId);
  }
}

export async function listRivalries(discordUserId: string): Promise<Rivalry[]> {
  const result = await getPool().query(
    "SELECT * FROM rivalry WHERE discord_user_id = $1 ORDER BY created_at",
    [discordUserId],
  );
  return result.rows.map(toRivalry);
}

export async function removeRivalry(discordUserId: string, id: number): Promise<Rivalry | undefined> {
  const result = await getPool().query(
    "DELETE FROM rivalry WHERE discord_user_id = $1 AND id = $2 RETURNING *",
    [discordUserId, id],
  );
  return result.rows[0] ? toRivalry(result.rows[0]) : undefined;
}

export interface Standing {
  mine?: BoardScore;
  theirs?: BoardScore;
}

// Live all-time standings for one rivalry board; undefined when the song has
// no leaderboard for that instrument.
export async function fetchStanding(
  track: Track,
  instrument: Instrument,
  myAccountId: string,
  rivalAccountId: string,
): Promise<Standing | undefined> {
  if (!track.eventId) {
    return undefined;
  }
  const scores = await fetchAllTimeScores(track.eventId, instrument, [myAccountId, rivalAccountId]);
  return scores && { mine: scores.get(myAccountId), theirs: scores.get(rivalAccountId) };
}

// Saves a new rivalry with its current standing, so the first hourly check
// only alerts on a real change. Re-adding the same one refreshes it.
export async function addRivalry(
  discordUserId: string,
  rival: EpicAccount,
  track: Track,
  instrument: Instrument,
  standing: Standing,
): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO rivalry (discord_user_id, rival_account_id, rival_display_name, track_id, instrument,
       my_score, rival_score, my_rank, rival_rank, checked_at, week_my_rank, week_rival_rank)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $8, $9)
     ON CONFLICT (discord_user_id, rival_account_id, track_id, instrument) DO UPDATE
       SET rival_display_name = excluded.rival_display_name, my_score = excluded.my_score,
           rival_score = excluded.rival_score, my_rank = excluded.my_rank, rival_rank = excluded.rival_rank,
           checked_at = now()
     RETURNING id`,
    [
      discordUserId,
      rival.id,
      rival.displayName,
      track.id,
      instrument,
      standing.mine?.score ?? null,
      standing.theirs?.score ?? null,
      standing.mine?.rank ?? null,
      standing.theirs?.rank ?? null,
    ],
  );
  return result.rows[0].id as number;
}

export function countRivalries(discordUserId: string): Promise<number> {
  return getPool()
    .query("SELECT count(*)::int AS n FROM rivalry WHERE discord_user_id = $1", [discordUserId])
    .then((r) => r.rows[0].n as number);
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function boardName(track: Track | undefined, trackId: string, instrument: Instrument): string {
  return `${track?.title ?? trackId} · ${INSTRUMENTS[instrument]}`;
}

function scoreLine(name: string, score: BoardScore | { rank: number | null; score: number | null } | undefined): string {
  if (!score || score.score === null || score.rank === null) {
    return `**${name}** — no score yet`;
  }
  const top = score.rank <= TOP_BOARD_SIZE ? "🏆 " : "";
  const extra = "accuracy" in score && score.accuracy !== undefined
    ? ` · ${score.accuracy}%${score.fullCombo ? " FC" : ""}`
    : "";
  return `${top}**${name}** — #${fmt(score.rank)} · ${fmt(score.score)}${extra}`;
}

function gapLine(mine: number | null | undefined, theirs: number | null | undefined, rivalName: string): string {
  const gap = (theirs ?? 0) - (mine ?? 0);
  if (gap > 0) {
    return `You're **${fmt(gap)}** behind ${rivalName}.`;
  }
  if (gap < 0) {
    return `You're **${fmt(-gap)}** ahead of ${rivalName}.`;
  }
  return `You're tied with ${rivalName}.`;
}

// The standings card used by /rival add and the overtake DM.
export function buildStandingEmbed(
  kind: "added" | "overtaken",
  track: Track,
  instrument: Instrument,
  me: string,
  rivalName: string,
  standing: Standing,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(RIVAL_COLOR)
    .setAuthor({ name: kind === "overtaken" ? "⚔️ Fortnite Festival · Rival alert" : "⚔️ Fortnite Festival · Rivalry added" })
    .setTitle(kind === "overtaken" ? `${rivalName} just passed you on ${track.title}` : `You vs ${rivalName}`)
    .setDescription(
      [
        `**${track.title}** — ${track.artist} · ${INSTRUMENTS[instrument]} · all-time`,
        "",
        scoreLine(rivalName, standing.theirs),
        scoreLine(`You (${me})`, standing.mine),
        "",
        gapLine(standing.mine?.score, standing.theirs?.score, rivalName),
      ].join("\n"),
    )
    .setFooter({ text: kind === "overtaken" ? "Checked hourly · weekly report on Sundays" : "I'll DM you if they pass you · weekly report on Sundays" })
    .setTimestamp();
  if (track.cover) {
    embed.setThumbnail(track.cover);
  }
  return embed;
}

export function buildRemoveRow(rivalryId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RIVAL_REMOVE_PREFIX}:${rivalryId}`)
      .setLabel("Stop this rivalry")
      .setEmoji("🏳️")
      .setStyle(ButtonStyle.Secondary),
  );
}

// Hourly: refresh every rivalry board (one request per song + instrument,
// covering everyone involved) and DM anyone whose rival just went from at or
// below them to above them.
async function checkRivalries(client: Client): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT r.*, l.epic_account_id, l.epic_display_name
     FROM rivalry r JOIN epic_link l ON l.discord_user_id = r.discord_user_id`,
  );
  const boards = new Map<string, { trackId: string; instrument: Instrument; rows: (Rivalry & { me: string; meName: string })[] }>();
  for (const row of result.rows) {
    const rivalry = { ...toRivalry(row), me: row.epic_account_id as string, meName: row.epic_display_name as string };
    const key = `${rivalry.trackId}:${rivalry.instrument}`;
    const board = boards.get(key) ?? { trackId: rivalry.trackId, instrument: rivalry.instrument, rows: [] };
    board.rows.push(rivalry);
    boards.set(key, board);
  }

  for (const board of boards.values()) {
    const track = getTrack(board.trackId);
    if (!track?.eventId) {
      continue;
    }
    let scores: Map<string, BoardScore> | undefined;
    try {
      scores = await fetchAllTimeScores(
        track.eventId,
        board.instrument,
        board.rows.flatMap((r) => [r.me, r.rivalAccountId]),
      );
    } catch (err) {
      console.error(`[rivals] ${boardName(track, board.trackId, board.instrument)} failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (!scores) {
      continue;
    }

    for (const r of board.rows) {
      const mine = scores.get(r.me);
      const theirs = scores.get(r.rivalAccountId);
      await pool.query(
        `UPDATE rivalry SET my_score = $2, rival_score = $3, my_rank = $4, rival_rank = $5, checked_at = now(),
           week_my_rank = COALESCE(week_my_rank, $4), week_rival_rank = COALESCE(week_rival_rank, $5)
         WHERE id = $1`,
        [r.id, mine?.score ?? null, theirs?.score ?? null, mine?.rank ?? null, theirs?.rank ?? null],
      );

      const wasAhead = (r.rivalScore ?? 0) > (r.myScore ?? 0);
      const isAhead = (theirs?.score ?? 0) > (mine?.score ?? 0);
      if (r.checkedAt && !wasAhead && isAhead) {
        try {
          const user = await client.users.fetch(r.discordUserId);
          await user.send({
            embeds: [buildStandingEmbed("overtaken", track, r.instrument, r.meName, r.rivalName, { mine, theirs })],
            components: [buildRemoveRow(r.id)],
          });
        } catch (err) {
          console.error(`[rivals] failed to DM ${r.discordUserId}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
}

// The most recent report time at or before `now`.
function lastReportBoundary(now: Date): Date {
  const boundary = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), REPORT_HOUR_UTC));
  boundary.setUTCDate(boundary.getUTCDate() - ((boundary.getUTCDay() - REPORT_DAY + 7) % 7));
  if (boundary > now) {
    boundary.setUTCDate(boundary.getUTCDate() - 7);
  }
  return boundary;
}

function rankChange(previous: number | null, current: number | null): string {
  if (previous === null || current === null || previous === current) {
    return "";
  }
  // A lower rank number is better.
  return previous > current ? ` ▲${fmt(previous - current)}` : ` ▼${fmt(current - previous)}`;
}

function reportField(r: Rivalry, meName: string): { name: string; value: string } {
  const track = getTrack(r.trackId);
  const line = (name: string, rank: number | null, score: number | null, weekRank: number | null) =>
    rank === null || score === null
      ? `**${name}** — no score yet`
      : `${rank <= TOP_BOARD_SIZE ? "🏆 " : ""}**${name}** — #${fmt(rank)}${rankChange(weekRank, rank)} · ${fmt(score)}`;
  return {
    name: boardName(track, r.trackId, r.instrument),
    value: [
      line(`You (${meName})`, r.myRank, r.myScore, r.weekMyRank),
      line(r.rivalName, r.rivalRank, r.rivalScore, r.weekRivalRank),
      gapLine(r.myScore, r.rivalScore, r.rivalName),
    ].join("\n"),
  };
}

// Weekly: once per boundary, a DM with the top 10,000 summary (if the person
// picked instruments with /top10k) and every rivalry board's standing, with
// rank changes since the previous report. Rivalry numbers come from the
// hourly check that runs just before, so they're at most an hour old.
async function sendWeeklyReports(client: Client): Promise<void> {
  const pool = getPool();
  const boundary = lastReportBoundary(new Date());
  const due = await pool.query(
    `SELECT l.discord_user_id, l.epic_account_id, l.epic_display_name
     FROM epic_link l
     LEFT JOIN rivalry_report rr ON rr.discord_user_id = l.discord_user_id
     WHERE (rr.sent_at IS NULL OR rr.sent_at < $1)
       AND (EXISTS (SELECT 1 FROM rivalry r WHERE r.discord_user_id = l.discord_user_id AND r.created_at < $1)
         OR EXISTS (SELECT 1 FROM top10k_instrument t WHERE t.discord_user_id = l.discord_user_id AND t.created_at < $1))`,
    [boundary],
  );
  if (due.rows.length === 0) {
    return;
  }
  const users = due.rows.map((row) => ({
    discordUserId: row.discord_user_id as string,
    accountId: row.epic_account_id as string,
    meName: row.epic_display_name as string,
  }));
  const top10k = await sweepTop10k(users);
  const week = boundary.toLocaleDateString("en-GB", { day: "numeric", month: "long" });

  for (const { discordUserId: userId, meName } of users) {
    const embeds: EmbedBuilder[] = [];
    const top = top10k.get(userId);
    if (top) {
      embeds.push(...buildTop10kEmbeds(top));
    }
    const fields = (await listRivalries(userId)).map((r) => reportField(r, meName));
    for (let i = 0; i < fields.length; i += 25) {
      const embed = new EmbedBuilder().setColor(REPORT_COLOR).addFields(fields.slice(i, i + 25));
      if (i === 0) {
        embed
          .setAuthor({ name: "⚔️ Fortnite Festival · Rivalries" })
          .setFooter({ text: "Rank changes since last week · manage rivalries with /rival list" });
      }
      embeds.push(embed);
    }
    if (embeds.length === 0) {
      continue;
    }

    try {
      const user = await client.users.fetch(userId);
      for (let i = 0; i < embeds.length; i += 10) {
        await user.send({
          content: i === 0 ? `📊 **Weekly Festival report** — ${meName}, week of ${week}` : undefined,
          embeds: embeds.slice(i, i + 10),
        });
      }
      await pool.query(
        `INSERT INTO rivalry_report (discord_user_id, sent_at) VALUES ($1, $2)
         ON CONFLICT (discord_user_id) DO UPDATE SET sent_at = excluded.sent_at`,
        [userId, boundary],
      );
      await pool.query(
        "UPDATE rivalry SET week_my_rank = my_rank, week_rival_rank = rival_rank WHERE discord_user_id = $1",
        [userId],
      );
      if (top) {
        await saveTop10k(userId, top);
      }
    } catch (err) {
      console.error(`[rivals] weekly report to ${userId} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function startRivalWatcher(client: Client): Promise<void> {
  await ensureRivalTables();
  await ensureTop10kTables();
  if (!isEpicConfigured()) {
    console.warn("[rivals] EPIC_DEVICE_AUTH is not set; rivalries are disabled");
    return;
  }
  // A top 10,000 sweep can outlast the hour, so ticks never overlap.
  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await checkRivalries(client);
      await sendWeeklyReports(client);
    } catch (err) {
      console.error(`[rivals] check failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
    }
  };
  // Give the festival watcher time to load the catalog, which maps tracks to
  // their leaderboards.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), CHECK_MS);
  }, FIRST_CHECK_DELAY_MS);
}
