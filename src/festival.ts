import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { getPool } from "./db.js";
import { fetchTimelineRotation, isTimelineConfigured } from "./epic.js";

// Epic's own content API — the full Jam Track catalog, no auth needed.
const CATALOG_URL =
  "https://fortnitecontent-website-prod07.ol.epicgames.com/content/api/pages/fortnite-game/spark-tracks";
// Fallback when the Epic timeline isn't configured or fails: fnfestival.co
// mirrors the rotation daily, but without end times. Tracks share Epic's
// short names as ids; the ones whose lastFeatured falls on the same UTC day
// as _metadata.lastUpdated are in today's rotation.
const ROTATION_URL = "https://fnfestival.co/data/tracks.json";
const DAY_MS = 24 * 60 * 60 * 1000;

const POLL_MS = 15 * 60 * 1000;
const STALE_ROTATION_MS = 36 * 60 * 60 * 1000;
// A diff bigger than this is a glitch (e.g. a partial catalog), not a release.
const MAX_RELEASES_PER_POLL = 30;

export const FESTIVAL_COLOR = 0xb44cff;
const RELEASE_COLOR = 0x2fd4ff;
const LEAVING_COLOR = 0xff8a3d;
export const UNSUBSCRIBE_PREFIX = "festunsub";
export const SUBSCRIBE_PREFIX = "festsub";
export const RELEASE_ALERTS_PREFIX = "festrel";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  cover?: string;
  durationSec?: number;
  bpm?: number;
  key?: string;
  genres: string[];
  // `artist` split into the individual credited artists.
  artists: string[];
  // When the track went live in Epic's catalog.
  releasedAt?: string;
  // 0–6, the same scale as the in-game difficulty bars.
  difficulty: { lead?: number; bass?: number; drums?: number; vocals?: number };
}

interface EpicTrack {
  sn: string;
  tt: string;
  an: string;
  ab?: string;
  ry?: number;
  au?: string;
  dn?: number;
  mt?: number;
  mk?: string;
  mm?: string;
  ge?: string[];
  in?: { gr?: number; ba?: number; ds?: number; vl?: number };
}

interface RotationFile {
  _metadata?: { lastUpdated?: string };
  [id: string]: { lastFeatured?: string | null } | { lastUpdated?: string } | undefined;
}

let catalog = new Map<string, Track>();
// Track id -> when it leaves the rotation (undefined when the source can't say).
let rotation = new Map<string, Date | undefined>();

export function getTrack(id: string): Track | undefined {
  return catalog.get(id);
}

export function isInRotation(id: string): boolean {
  return rotation.has(id);
}

export function rotationEndsAt(id: string): Date | undefined {
  return rotation.get(id);
}

export type CatalogView = "all" | "rotation" | "new";

// A query of "artist:<key>" lists exactly that artist's songs (see
// listArtists); any other query is a text search.
export const ARTIST_QUERY_PREFIX = "artist:";

// Alphabetical, except "new" which is newest release first. A text search
// keeps searchTracks' relevance order.
export function listTracks(view: CatalogView, query = ""): Track[] {
  const q = query.trim();
  const artistKey = q.startsWith(ARTIST_QUERY_PREFIX) ? normalize(q.slice(ARTIST_QUERY_PREFIX.length)) : undefined;
  const search = artistKey === undefined && q !== "";

  let tracks = search ? searchTracks(q, Infinity) : [...catalog.values()].sort((a, b) => a.title.localeCompare(b.title));
  if (artistKey !== undefined) {
    tracks = tracks.filter((t) => t.artists.some((a) => normalize(a) === artistKey));
  }
  if (view === "rotation") {
    tracks = tracks.filter((t) => rotation.has(t.id));
  } else if (view === "new" && !search) {
    tracks.sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
  }
  return tracks;
}

export interface Artist {
  key: string;
  name: string;
  songs: number;
  inRotation: number;
}

export type ArtistSort = "count" | "name";

// Every credited artist, collaborators included, with how many songs they're
// on. Sorted by song count, or A–Z.
export function listArtists(sort: ArtistSort, query = ""): Artist[] {
  const byKey = new Map<string, Artist>();
  for (const track of catalog.values()) {
    for (const name of track.artists) {
      const key = normalize(name);
      const artist = byKey.get(key) ?? { key, name, songs: 0, inRotation: 0 };
      artist.songs++;
      if (rotation.has(track.id)) {
        artist.inRotation++;
      }
      byKey.set(key, artist);
    }
  }
  const q = normalize(query);
  return [...byKey.values()]
    .filter((a) => !q || a.key.includes(q))
    .sort((a, b) => (sort === "count" ? b.songs - a.songs : 0) || a.name.localeCompare(b.name));
}

export function getArtistName(key: string): string | undefined {
  for (const track of catalog.values()) {
    const name = track.artists.find((a) => normalize(a) === key);
    if (name) {
      return name;
    }
  }
  return undefined;
}

// Names Epic credits that contain a separator but are one act.
const SINGLE_ACTS = new Set(["earth, wind & fire", "coheed and cambria", "rob base & dj ez rock", "haute & freddy"]);

// Splits an Epic credit like "Snoop Dogg & Wiz Khalifa ft. Bruno Mars" into
// its artists. ",", "&" and "and" don't split before "The ...", which keeps
// "Tyler, The Creator" and "Huey Lewis & The News" whole.
function splitArtists(credit: string): string[] {
  const trimmed = credit.trim();
  if (!trimmed) {
    return [];
  }
  if (SINGLE_ACTS.has(trimmed.toLowerCase())) {
    return [trimmed];
  }
  return trimmed
    .split(/\s+(?:ft\.|feat\.|featuring|w\/)\s+|(?:,|\s+&|\s+and)\s+(?!the\s)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

async function refreshCatalog(): Promise<void> {
  const page = await fetchJson<Record<string, unknown>>(CATALOG_URL);
  const next = new Map<string, Track>();
  for (const entry of Object.values(page)) {
    const { track: t, _activeDate } = (entry ?? {}) as { track?: EpicTrack; _activeDate?: string };
    if (!t?.sn || !t.tt) {
      continue;
    }
    next.set(t.sn, {
      id: t.sn,
      title: t.tt.trim(),
      artist: (t.an ?? "").trim(),
      album: t.ab?.trim() || undefined,
      year: t.ry,
      cover: t.au,
      durationSec: t.dn,
      bpm: t.mt,
      key: t.mk ? `${t.mk} ${t.mm ?? ""}`.trim() : undefined,
      genres: t.ge ?? [],
      artists: splitArtists(t.an ?? ""),
      releasedAt: _activeDate,
      difficulty: { lead: t.in?.gr, bass: t.in?.ba, drums: t.in?.ds, vocals: t.in?.vl },
    });
  }
  if (next.size === 0) {
    throw new Error("catalog came back empty");
  }
  if (catalog.size !== next.size) {
    console.log(`[festival] catalog loaded — ${next.size} tracks`);
  }
  catalog = next;
}

async function fetchRotation(): Promise<Map<string, Date | undefined>> {
  if (isTimelineConfigured()) {
    try {
      return await fetchTimelineRotation();
    } catch (err) {
      console.error(`[festival] Epic timeline failed, using fnfestival.co: ${err instanceof Error ? err.message : err}`);
    }
  }
  return new Map([...(await fetchFnfestivalRotation())].map((id) => [id, undefined]));
}

async function fetchFnfestivalRotation(): Promise<Set<string>> {
  const file = await fetchJson<RotationFile>(ROTATION_URL);
  const lastUpdated = file._metadata?.lastUpdated;
  if (!lastUpdated) {
    throw new Error("rotation file has no _metadata.lastUpdated");
  }
  if (Date.now() - Date.parse(lastUpdated) > STALE_ROTATION_MS) {
    console.warn(`[festival] rotation data is stale (last updated ${lastUpdated})`);
  }

  const day = lastUpdated.slice(0, 10);
  const ids = new Set<string>();
  for (const [id, entry] of Object.entries(file)) {
    if (id === "_metadata" || !entry || !("lastFeatured" in entry)) {
      continue;
    }
    if (entry.lastFeatured?.slice(0, 10) === day) {
      ids.add(id);
    }
  }
  if (ids.size === 0) {
    throw new Error(`no tracks featured on ${day}`);
  }
  return ids;
}

export async function ensureFestivalTables(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS festival_subscription (
      discord_user_id text NOT NULL,
      track_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (discord_user_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS festival_rotation (
      track_id text PRIMARY KEY,
      seen_at timestamptz NOT NULL DEFAULT now(),
      active_until timestamptz,
      -- set once the "last day" DM went out for this stint
      reminded_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS festival_catalog (
      track_id text PRIMARY KEY,
      seen_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS festival_release_alert (
      discord_user_id text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

// Subscribing to anything also opts you into new-release alerts, unless
// you've turned them off before.
export async function subscribe(discordUserId: string, trackIds: string[]): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO festival_subscription (discord_user_id, track_id)
     SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [discordUserId, trackIds],
  );
  await pool.query(
    "INSERT INTO festival_release_alert (discord_user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [discordUserId],
  );
  return result.rowCount ?? 0;
}

export async function unsubscribe(discordUserId: string, trackId: string): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM festival_subscription WHERE discord_user_id = $1 AND track_id = $2",
    [discordUserId, trackId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listSubscriptions(discordUserId: string): Promise<string[]> {
  const result = await getPool().query(
    "SELECT track_id FROM festival_subscription WHERE discord_user_id = $1 ORDER BY created_at",
    [discordUserId],
  );
  return result.rows.map((row) => row.track_id as string);
}

export async function setReleaseAlerts(discordUserId: string, enabled: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO festival_release_alert (discord_user_id, enabled) VALUES ($1, $2)
     ON CONFLICT (discord_user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = now()`,
    [discordUserId, enabled],
  );
}

export async function hasReleaseAlerts(discordUserId: string): Promise<boolean> {
  const result = await getPool().query(
    "SELECT enabled FROM festival_release_alert WHERE discord_user_id = $1",
    [discordUserId],
  );
  return result.rows[0]?.enabled === true;
}

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Title prefix beats word prefix beats anywhere-in-title-or-artist; tracks in
// rotation right now win ties. An empty query lists the current rotation.
export function searchTracks(query: string, limit = 25): Track[] {
  const q = normalize(query);
  const scored: { track: Track; score: number }[] = [];
  for (const track of catalog.values()) {
    let score: number;
    if (!q) {
      score = rotation.has(track.id) ? 1 : 0;
    } else {
      const title = normalize(track.title);
      const haystack = `${title} ${normalize(track.artist)}`;
      if (title.startsWith(q)) {
        score = 4;
      } else if (` ${title}`.includes(` ${q}`)) {
        score = 3;
      } else if (haystack.includes(q)) {
        score = 2;
      } else {
        continue;
      }
    }
    if (score === 0) {
      continue;
    }
    scored.push({ track, score: score * 2 + (rotation.has(track.id) ? 1 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title))
    .slice(0, limit)
    .map((s) => s.track);
}

function bars(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  const filled = Math.max(0, Math.min(6, value)) + 1;
  return "▰".repeat(filled) + "▱".repeat(7 - filled);
}

function formatDuration(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function formatSpan(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

type EmbedKind = "rotation" | "leaving" | "release";

const EMBED_STYLE: Record<EmbedKind, { color: number; author: string }> = {
  rotation: { color: FESTIVAL_COLOR, author: "🎸 Fortnite Festival · Free Rotation" },
  leaving: { color: LEAVING_COLOR, author: "⏳ Fortnite Festival · Last day in rotation" },
  release: { color: RELEASE_COLOR, author: "🆕 Fortnite Festival · New Jam Track" },
};

export function buildTrackEmbed(track: Track, kind: EmbedKind = "rotation"): EmbedBuilder {
  const subtitle = [track.artist, track.album, track.year].filter(Boolean).join(" · ");
  const { lead, bass, drums, vocals } = track.difficulty;
  const details = [
    track.durationSec ? `⏱️ ${formatDuration(track.durationSec)}` : undefined,
    track.bpm ? `🥁 ${track.bpm} BPM` : undefined,
    track.key ? `🎼 ${track.key}` : undefined,
    track.genres.length > 0 ? `🏷️ ${track.genres.join(", ")}` : undefined,
  ].filter(Boolean);

  const until = rotation.get(track.id);
  let blurb = "In the free rotation right now — play it on Main Stage without owning it.";
  if (kind === "rotation" && until) {
    blurb = `In the free rotation for the next **${formatSpan(until.getTime() - Date.now())}** — play it on Main Stage without owning it.`;
  } else if (kind === "leaving") {
    blurb = "Less than a day left in the free rotation — last chance to play it without owning it.";
  } else if (kind === "release") {
    blurb = rotation.has(track.id)
      ? "Just added to the Jam Track catalog, and 🟢 in the free rotation right now."
      : "Just added to the Jam Track catalog. Get rotation alerts below to hear when you can play it free.";
  }

  const embed = new EmbedBuilder()
    .setColor(EMBED_STYLE[kind].color)
    .setAuthor({ name: EMBED_STYLE[kind].author })
    .setTitle(track.title)
    .setDescription(`**${subtitle}**\n\n${blurb}`);
  if (until && kind !== "release") {
    // Discord renders these in the reader's own timezone, with a live countdown.
    const unix = Math.floor(until.getTime() / 1000);
    embed.addFields({ name: "Leaves rotation", value: `<t:${unix}:R> · <t:${unix}:f>` });
  }
  embed
    .addFields(
      {
        name: "Difficulty",
        value: [
          `\`Lead  \` ${bars(lead)}`,
          `\`Bass  \` ${bars(bass)}`,
          `\`Drums \` ${bars(drums)}`,
          `\`Vocals\` ${bars(vocals)}`,
        ].join("\n"),
      },
      ...(details.length > 0 ? [{ name: "Details", value: details.join("  ·  ") }] : []),
    )
    .setFooter({ text: kind === "release" ? "Released" : "Fortnite Festival free rotation" })
    .setTimestamp(kind === "release" && track.releasedAt ? new Date(track.releasedAt) : new Date());
  if (track.cover) {
    embed.setThumbnail(track.cover);
  }
  return embed;
}

export function buildUnsubscribeRow(trackId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${UNSUBSCRIBE_PREFIX}:${trackId}`)
      .setLabel("Unsubscribe")
      .setEmoji("🔕")
      .setStyle(ButtonStyle.Secondary),
  );
}

// One DM per user for the whole drop: up to 10 embeds, a multi-select to get
// rotation alerts for any of them, and an opt-out button.
function buildReleaseMessages(tracks: Track[]) {
  const messages = [];
  for (let i = 0; i < tracks.length; i += 10) {
    const chunk = tracks.slice(i, i + 10);
    const select = new StringSelectMenuBuilder()
      .setCustomId(SUBSCRIBE_PREFIX)
      .setPlaceholder("🔔 Get rotation alerts for…")
      .setMinValues(1)
      .setMaxValues(chunk.length)
      .addOptions(
        chunk.map((t) => ({
          label: t.title.slice(0, 100),
          description: t.artist.slice(0, 100) || undefined,
          value: t.id,
        })),
      );
    messages.push({
      embeds: chunk.map((t) => buildTrackEmbed(t, "release")),
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${RELEASE_ALERTS_PREFIX}:off`)
            .setLabel("Stop new-song alerts")
            .setEmoji("🔕")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }
  return messages;
}

// Catalog rows are never deleted, so a track Epic pulls and later re-adds
// doesn't count as a new release.
async function checkNewReleases(client: Client): Promise<void> {
  const pool = getPool();
  const known = new Set(
    (await pool.query("SELECT track_id FROM festival_catalog")).rows.map((r) => r.track_id as string),
  );
  const added = [...catalog.keys()].filter((id) => !known.has(id));
  if (added.length === 0) {
    return;
  }
  await pool.query(
    "INSERT INTO festival_catalog (track_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
    [added],
  );
  if (known.size === 0 || added.length > MAX_RELEASES_PER_POLL) {
    console.log(`[festival] seeded ${added.length} catalog tracks without alerting`);
    return;
  }

  const tracks = added
    .map((id) => catalog.get(id))
    .filter((t) => t !== undefined)
    .sort((a, b) => a.title.localeCompare(b.title));
  console.log(`[festival] new releases: ${tracks.map((t) => t.title).join(", ")}`);

  const users = await pool.query("SELECT discord_user_id FROM festival_release_alert WHERE enabled");
  const messages = buildReleaseMessages(tracks);
  for (const { discord_user_id } of users.rows as { discord_user_id: string }[]) {
    try {
      const user = await client.users.fetch(discord_user_id);
      for (const message of messages) {
        await user.send(message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[festival] failed to DM ${discord_user_id} about new releases: ${message}`);
    }
  }
}

// Local design check (FESTIVAL_PREVIEW=1): DMs one of each alert, built from
// the live catalog and rotation, without touching any stored state.
export async function sendPreview(client: Client, discordUserId: string): Promise<number> {
  const user = await client.users.fetch(discordUserId);
  const inRotation = [...rotation.keys()]
    .map((id) => catalog.get(id))
    .filter((t) => t !== undefined)
    .sort((a, b) => (rotation.get(a.id)?.getTime() ?? Infinity) - (rotation.get(b.id)?.getTime() ?? Infinity));
  const newest = [...catalog.values()]
    .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""))
    .slice(0, 2);

  let sent = 0;
  const entering = inRotation.at(-1);
  if (entering) {
    await user.send({ embeds: [buildTrackEmbed(entering)], components: [buildUnsubscribeRow(entering.id)] });
    sent++;
  }
  const leaving = inRotation[0];
  if (leaving) {
    await user.send({ embeds: [buildTrackEmbed(leaving, "leaving")], components: [buildUnsubscribeRow(leaving.id)] });
    sent++;
  }
  for (const message of buildReleaseMessages(newest)) {
    await user.send(message);
    sent++;
  }
  return sent;
}

async function notifySubscribers(
  client: Client,
  trackIds: string[],
  kind: "rotation" | "leaving" = "rotation",
): Promise<void> {
  const result = await getPool().query(
    "SELECT discord_user_id, track_id FROM festival_subscription WHERE track_id = ANY($1)",
    [trackIds],
  );
  for (const row of result.rows as { discord_user_id: string; track_id: string }[]) {
    const track = catalog.get(row.track_id);
    if (!track) {
      continue;
    }
    try {
      const user = await client.users.fetch(row.discord_user_id);
      await user.send({ embeds: [buildTrackEmbed(track, kind)], components: [buildUnsubscribeRow(track.id)] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[festival] failed to DM ${row.discord_user_id} about ${track.id}: ${message}`);
    }
  }
}

// Diffs the live rotation against the last one we saw (persisted, so restarts
// don't re-notify), DMs subscribers of every track that just entered it, and
// once per stint DMs them again when a track has less than a day left.
async function pollRotation(client: Client): Promise<void> {
  const current = await fetchRotation();
  rotation = current;

  const pool = getPool();
  const previous = new Map(
    (await pool.query("SELECT track_id, active_until, reminded_at FROM festival_rotation")).rows.map((r) => [
      r.track_id as string,
      { until: r.active_until as Date | null, reminded: r.reminded_at !== null },
    ]),
  );
  const entered = [...current.keys()].filter((id) => !previous.has(id));
  const left = [...previous.keys()].filter((id) => !current.has(id));

  if (left.length > 0) {
    await pool.query("DELETE FROM festival_rotation WHERE track_id = ANY($1)", [left]);
  }
  // A stint that's already under a day long gets no separate reminder; the
  // entry DM shows the countdown.
  for (const id of entered) {
    const until = current.get(id);
    const short = until !== undefined && until.getTime() - Date.now() <= DAY_MS;
    await pool.query(
      "INSERT INTO festival_rotation (track_id, active_until, reminded_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [id, until ?? null, short ? new Date() : null],
    );
  }
  // Epic sometimes extends a stint; a fresh 24h+ window earns a fresh reminder.
  for (const [id, prev] of previous) {
    const until = current.get(id);
    if (until && until.getTime() !== prev.until?.getTime()) {
      const reset = until.getTime() - Date.now() > DAY_MS;
      await pool.query(
        `UPDATE festival_rotation SET active_until = $2${reset ? ", reminded_at = NULL" : ""} WHERE track_id = $1`,
        [id, until],
      );
      prev.reminded &&= !reset;
    }
  }
  if (entered.length > 0 || left.length > 0) {
    console.log(`[festival] rotation changed — ${entered.length} in, ${left.length} out (${current.size} total)`);
  }

  // The very first poll only seeds the table; everything would look "new".
  if (previous.size > 0 && entered.length > 0) {
    await notifySubscribers(client, entered);
  }

  const leaving = [...previous]
    .filter(([id, prev]) => {
      const until = current.get(id);
      return until !== undefined && !prev.reminded && until.getTime() - Date.now() <= DAY_MS;
    })
    .map(([id]) => id);
  if (leaving.length > 0) {
    await pool.query("UPDATE festival_rotation SET reminded_at = now() WHERE track_id = ANY($1)", [leaving]);
    await notifySubscribers(client, leaving, "leaving");
  }
}

async function poll(client: Client): Promise<void> {
  // Rotation first, so release embeds know whether a new track is free today.
  await pollRotation(client).catch((err) => {
    console.error(`[festival] rotation poll failed: ${err instanceof Error ? err.message : err}`);
  });
  try {
    await refreshCatalog();
    await checkNewReleases(client);
  } catch (err) {
    console.error(`[festival] catalog poll failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function startFestivalWatcher(client: Client): Promise<void> {
  await ensureFestivalTables();
  // Autocomplete needs the catalog before the first rotation diff runs.
  await refreshCatalog().catch((err) => {
    console.error(`[festival] initial catalog load failed: ${err instanceof Error ? err.message : err}`);
  });
  await poll(client);
  setInterval(() => void poll(client), POLL_MS);
}
