import { EmbedBuilder } from "discord.js";
import { getPool } from "./db.js";
import { type BoardScore, fetchAllTimeScores, INSTRUMENTS, type Instrument } from "./epic.js";
import { getTrack, listTracks } from "./festival.js";

// Top 10,000 tracking: each person picks instruments with /top10k, and before
// the weekly report the bot looks up their all-time rank on every song for
// those instruments. One request per song + instrument covers everyone who
// picked it, spaced out so a full sweep is gentle on Epic.

export const TOP_BOARD_SIZE = 10_000;
const SWEEP_DELAY_MS = 500;
// This many failed boards in a row means Epic is down or the login broke;
// the sweep gives up and the report retries in 15 minutes.
const MAX_CONSECUTIVE_FAILURES = 10;
const TOP10K_COLOR = 0xffc83d;

export async function ensureTop10kTables(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS top10k_instrument (
      discord_user_id text NOT NULL,
      instrument text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      swept_at timestamptz,
      PRIMARY KEY (discord_user_id, instrument)
    );
    -- top 10,000 entries as of the last report, for the week-over-week change
    CREATE TABLE IF NOT EXISTS top10k_rank (
      discord_user_id text NOT NULL,
      track_id text NOT NULL,
      instrument text NOT NULL,
      rank integer NOT NULL,
      score integer NOT NULL,
      PRIMARY KEY (discord_user_id, track_id, instrument)
    );
  `);
}

export async function getTop10kInstruments(discordUserId: string): Promise<Instrument[]> {
  const result = await getPool().query("SELECT instrument FROM top10k_instrument WHERE discord_user_id = $1", [discordUserId]);
  const picked = new Set(result.rows.map((r) => r.instrument as string));
  return (Object.keys(INSTRUMENTS) as Instrument[]).filter((i) => picked.has(i));
}

export async function setTop10kInstruments(discordUserId: string, instruments: Instrument[]): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM top10k_instrument WHERE discord_user_id = $1 AND NOT (instrument = ANY($2))", [discordUserId, instruments]);
  await pool.query("DELETE FROM top10k_rank WHERE discord_user_id = $1 AND NOT (instrument = ANY($2))", [discordUserId, instruments]);
  for (const instrument of instruments) {
    await pool.query(
      "INSERT INTO top10k_instrument (discord_user_id, instrument) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [discordUserId, instrument],
    );
  }
}

// Linking a different Epic account makes the stored ranks someone else's.
export async function clearTop10kRanks(discordUserId: string): Promise<void> {
  await getPool().query("DELETE FROM top10k_rank WHERE discord_user_id = $1", [discordUserId]);
  await getPool().query("UPDATE top10k_instrument SET swept_at = NULL WHERE discord_user_id = $1", [discordUserId]);
}

interface RankRow {
  trackId: string;
  instrument: Instrument;
  rank: number;
  score: number;
}

export interface Top10kReport {
  instruments: Instrument[];
  // In the top 10,000 now; previousRank is unset for new entries.
  entries: (RankRow & { previousRank?: number })[];
  // In the top 10,000 last week but not now; rank is where they are now.
  dropped: (RankRow & { previousRank: number })[];
  // No earlier sweep to compare with, so nothing is marked new.
  firstSweep: boolean;
  // What to store once the report is delivered.
  rows: RankRow[];
}

const boardKey = (trackId: string, instrument: string) => `${trackId}:${instrument}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Looks up every song on the picked instruments for these people. Only people
// who picked instruments get a report.
export async function sweepTop10k(users: { discordUserId: string; accountId: string }[]): Promise<Map<string, Top10kReport>> {
  const pool = getPool();
  const reports = new Map<string, Top10kReport>();
  if (users.length === 0) {
    return reports;
  }
  const accountOf = new Map(users.map((u) => [u.discordUserId, u.accountId]));
  const picked = await pool.query(
    "SELECT discord_user_id, instrument, swept_at FROM top10k_instrument WHERE discord_user_id = ANY($1)",
    [users.map((u) => u.discordUserId)],
  );
  const byInstrument = new Map<Instrument, string[]>();
  for (const row of picked.rows) {
    const instrument = row.instrument as Instrument;
    byInstrument.set(instrument, [...(byInstrument.get(instrument) ?? []), row.discord_user_id]);
    const report = reports.get(row.discord_user_id) ?? { instruments: [], entries: [], dropped: [], firstSweep: true, rows: [] };
    report.instruments.push(instrument);
    report.firstSweep &&= row.swept_at === null;
    reports.set(row.discord_user_id, report);
  }
  if (reports.size === 0) {
    return reports;
  }

  // Every score found, per person, including ones outside the top 10,000.
  const found = new Map<string, Map<string, BoardScore>>();
  const failed = new Set<string>();
  const tracks = listTracks("all").filter((t) => t.eventId);
  let consecutiveFailures = 0;
  for (const [instrument, userIds] of byInstrument) {
    for (const track of tracks) {
      try {
        const scores = await fetchAllTimeScores(track.eventId!, instrument, userIds.map((id) => accountOf.get(id)!));
        consecutiveFailures = 0;
        for (const userId of userIds) {
          const score = scores?.get(accountOf.get(userId)!);
          if (score) {
            const mine = found.get(userId) ?? new Map<string, BoardScore>();
            mine.set(boardKey(track.id, instrument), score);
            found.set(userId, mine);
          }
        }
      } catch (err) {
        failed.add(boardKey(track.id, instrument));
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`top 10k sweep gave up after ${consecutiveFailures} failed boards: ${err instanceof Error ? err.message : err}`);
        }
      }
      await sleep(SWEEP_DELAY_MS);
    }
  }
  if (failed.size > 0) {
    console.warn(`[top10k] ${failed.size} boards failed during the sweep; keeping their previous ranks`);
  }

  const previous = await pool.query("SELECT * FROM top10k_rank WHERE discord_user_id = ANY($1)", [[...reports.keys()]]);
  const previousByUser = new Map<string, Map<string, RankRow>>();
  for (const row of previous.rows) {
    const rows = previousByUser.get(row.discord_user_id) ?? new Map<string, RankRow>();
    rows.set(boardKey(row.track_id, row.instrument), {
      trackId: row.track_id,
      instrument: row.instrument,
      rank: row.rank,
      score: row.score,
    });
    previousByUser.set(row.discord_user_id, rows);
  }

  for (const [userId, report] of reports) {
    const before = previousByUser.get(userId) ?? new Map<string, RankRow>();
    const now = found.get(userId) ?? new Map<string, BoardScore>();
    for (const [key, score] of now) {
      if (score.rank > TOP_BOARD_SIZE) {
        continue;
      }
      const [trackId, instrument] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1) as Instrument];
      const row = { trackId, instrument, rank: score.rank, score: score.score };
      report.entries.push({ ...row, previousRank: before.get(key)?.rank });
      report.rows.push(row);
    }
    for (const [key, row] of before) {
      if (failed.has(key)) {
        // Unknown this week: carry the old entry over rather than report a drop.
        report.rows.push(row);
      } else if (!now.has(key) || now.get(key)!.rank > TOP_BOARD_SIZE) {
        report.dropped.push({ ...row, previousRank: row.rank, rank: now.get(key)?.rank ?? row.rank });
      }
    }
    report.entries.sort((a, b) => a.rank - b.rank);
    report.dropped.sort((a, b) => a.previousRank - b.previousRank);
  }
  return reports;
}

// Called after the report is delivered, so a failed DM retries against the
// same baseline.
export async function saveTop10k(discordUserId: string, report: Top10kReport): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM top10k_rank WHERE discord_user_id = $1", [discordUserId]);
  for (const row of report.rows) {
    await pool.query(
      "INSERT INTO top10k_rank (discord_user_id, track_id, instrument, rank, score) VALUES ($1, $2, $3, $4, $5)",
      [discordUserId, row.trackId, row.instrument, row.rank, row.score],
    );
  }
  await pool.query(
    "UPDATE top10k_instrument SET swept_at = now() WHERE discord_user_id = $1 AND instrument = ANY($2)",
    [discordUserId, report.instruments],
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

function boardLabel(row: RankRow): string {
  return `**${getTrack(row.trackId)?.title ?? row.trackId}** · ${INSTRUMENTS[row.instrument]}`;
}

export function buildTop10kEmbeds(report: Top10kReport): EmbedBuilder[] {
  const lines = report.entries.map((e) => {
    let change = "";
    if (e.previousRank === undefined) {
      change = report.firstSweep ? "" : " 🆕";
    } else if (e.previousRank !== e.rank) {
      change = e.previousRank > e.rank ? ` ▲${fmt(e.previousRank - e.rank)}` : ` ▼${fmt(e.rank - e.previousRank)}`;
    }
    return `\`#${fmt(e.rank)}\`${change} — ${boardLabel(e)} · ${fmt(e.score)}`;
  });
  if (lines.length === 0) {
    lines.push("No top 10,000 scores yet.");
  }
  if (report.dropped.length > 0) {
    lines.push("", "**Dropped out**");
    lines.push(...report.dropped.map((d) => `📉 ${boardLabel(d)} — #${fmt(d.rank)} (was #${fmt(d.previousRank)})`));
  }

  // Split into embeds at line boundaries, under the 4,096 description limit.
  const chunks: string[] = [""];
  for (const line of lines) {
    if (chunks[chunks.length - 1].length + line.length + 1 > 4000) {
      chunks.push("");
    }
    chunks[chunks.length - 1] += `${chunks[chunks.length - 1] ? "\n" : ""}${line}`;
  }
  const instruments = report.instruments.map((i) => INSTRUMENTS[i]).join(", ");
  return chunks.map((chunk, i) => {
    const embed = new EmbedBuilder().setColor(TOP10K_COLOR).setDescription(chunk);
    if (i === 0) {
      embed
        .setAuthor({ name: "🏆 Fortnite Festival · Top 10,000" })
        .setTitle(`${report.entries.length} all-time top 10,000 score${report.entries.length === 1 ? "" : "s"}`)
        .setFooter({ text: `${instruments} · rank changes since last week · change instruments with /top10k` });
    }
    return embed;
  });
}
