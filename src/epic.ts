// Reads the Festival free rotation, with end times, from Fortnite's calendar
// timeline. An anonymous client token lacks `fortnite:calendar READ`, so this
// logs in as an Epic account through a device auth (see
// scripts/epic-login.ts). Without EPIC_DEVICE_AUTH it stays disabled and the
// caller falls back to fnfestival.co, which has no end times.

const TOKEN_URL = "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token";
const TIMELINE_URL = "https://fngw-mcp-gc-livefn.ol.epicgames.com/fortnite/api/calendar/v1/timeline";
// Each track in the free rotation is its own event, e.g. "PilgrimSong.badguy".
const ROTATION_EVENT_PREFIX = "PilgrimSong.";

// clientId:secret of the Fortnite iOS game client, which device auths are
// issued under. Kept out of the repo; see .env.example.
function epicClient(): string {
  const client = process.env.EPIC_CLIENT;
  if (!client) {
    throw new Error("EPIC_CLIENT is not set");
  }
  return client;
}

interface DeviceAuth {
  accountId: string;
  deviceId: string;
  secret: string;
}

interface TimelineEvent {
  eventType: string;
  activeSince?: string;
  activeUntil?: string;
}

interface Timeline {
  channels?: {
    "client-events"?: { states?: { validFrom: string; activeEvents?: TimelineEvent[] }[] };
  };
}

let token: { value: string; expiresAt: number } | undefined;

function deviceAuth(): DeviceAuth | undefined {
  const raw = process.env.EPIC_DEVICE_AUTH;
  if (!raw) {
    return undefined;
  }
  const [accountId, deviceId, secret] = raw.split(":");
  if (!accountId || !deviceId || !secret) {
    throw new Error("EPIC_DEVICE_AUTH must be accountId:deviceId:secret");
  }
  return { accountId, deviceId, secret };
}

export function isTimelineConfigured(): boolean {
  return Boolean(process.env.EPIC_DEVICE_AUTH && process.env.EPIC_CLIENT);
}

// Leaderboards need the same login as the timeline.
export const isEpicConfigured = isTimelineConfigured;

export async function epicToken(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; account_id?: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(epicClient()).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Epic token request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number; account_id?: string };
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt - Date.now() > 5 * 60_000) {
    return token.value;
  }
  const auth = deviceAuth();
  if (!auth) {
    throw new Error("EPIC_DEVICE_AUTH is not set");
  }
  const result = await epicToken({
    grant_type: "device_auth",
    account_id: auth.accountId,
    device_id: auth.deviceId,
    secret: auth.secret,
    token_type: "eg1",
  });
  token = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  return token.value;
}

// A request as the logged-in Epic account. A 401 drops the cached token so
// the next call logs in again.
async function epicFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    token = undefined;
  }
  return res;
}

function loggedInAccountId(): string {
  const auth = deviceAuth();
  if (!auth) {
    throw new Error("EPIC_DEVICE_AUTH is not set");
  }
  return auth.accountId;
}

export interface EpicAccount {
  id: string;
  displayName: string;
}

// Exact Epic display name -> account, or undefined when no account has it.
export async function lookupEpicAccount(displayName: string): Promise<EpicAccount | undefined> {
  const res = await epicFetch(
    `https://account-public-service-prod.ol.epicgames.com/account/api/public/account/displayName/${encodeURIComponent(displayName)}`,
  );
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`account lookup responded ${res.status}`);
  }
  const body = (await res.json()) as { id: string; displayName: string };
  return { id: body.id, displayName: body.displayName };
}

// Leaderboard window codes, as the instrument part of an all-time board id.
export const INSTRUMENTS = {
  Solo_Guitar: "Lead",
  Solo_Bass: "Bass",
  Solo_Drums: "Drums",
  Solo_Vocals: "Vocals",
  Solo_PeripheralGuitar: "Pro Lead",
  Solo_PeripheralBass: "Pro Bass",
  Solo_PeripheralDrum: "Pro Drums",
  Solo_PeripheralCymbals: "Pro Drums + Cymbals",
  Solo_PeripheralVocals: "Karaoke",
} as const;
export type Instrument = keyof typeof INSTRUMENTS;

export interface BoardScore {
  accountId: string;
  rank: number;
  score: number;
  accuracy?: number;
  stars?: number;
  fullCombo?: boolean;
}

// Epic rejects more than somewhere in the 30s accounts per scores request.
const SCORES_BATCH = 25;

// All-time scores for specific accounts on one song + instrument. Unlike the
// public pages (top 10,000 only), this returns exact ranks at any depth.
// Accounts with no score are absent. Undefined means the song has no such
// leaderboard.
export async function fetchAllTimeScores(
  eventId: string,
  instrument: Instrument,
  accountIds: string[],
): Promise<Map<string, BoardScore> | undefined> {
  const scores = new Map<string, BoardScore>();
  const unique = [...new Set(accountIds)];
  for (let i = 0; i < unique.length; i += SCORES_BATCH) {
    const res = await epicFetch(
      `https://events-public-service-live.ol.epicgames.com/api/v2/games/FNFestival/leaderboards/alltime_${eventId}_${instrument}/alltime/scores?accountId=${loggedInAccountId()}&fromIndex=0&findTeams=false`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teams: unique.slice(i, i + SCORES_BATCH).map((id) => [id]) }),
      },
    );
    if (res.status === 400 || res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { errorCode?: string };
      // None of this batch has a score on the board.
      if (body.errorCode?.includes("no_score_found")) {
        continue;
      }
      if (body.errorCode?.includes("invalid_leaderboard") || body.errorCode?.includes("not_found")) {
        return undefined;
      }
      throw new Error(`scores responded ${res.status} ${body.errorCode ?? ""}`);
    }
    if (!res.ok) {
      throw new Error(`scores responded ${res.status}`);
    }
    type Entry = {
      teamAccountIds: string[];
      rank: number;
      score: number;
      sessionHistory?: { trackedStats?: Record<string, number> }[];
    };
    for (const entry of (await res.json()) as Entry[]) {
      // The best run is the one the score came from.
      const best = entry.sessionHistory
        ?.map((s) => s.trackedStats ?? {})
        .find((s) => s.SCORE === entry.score);
      scores.set(entry.teamAccountIds[0], {
        accountId: entry.teamAccountIds[0],
        rank: entry.rank,
        score: entry.score,
        accuracy: best?.ACCURACY !== undefined ? best.ACCURACY / 10_000 : undefined,
        stars: best?.STARS_EARNED,
        fullCombo: best?.FULL_COMBO !== undefined ? best.FULL_COMBO === 1 : undefined,
      });
    }
  }
  return scores;
}

// Track id -> when it leaves the rotation, from the newest timeline state
// that's already in effect.
export async function fetchTimelineRotation(): Promise<Map<string, Date | undefined>> {
  const res = await epicFetch(TIMELINE_URL);
  if (!res.ok) {
    throw new Error(`timeline responded ${res.status}`);
  }
  const timeline = (await res.json()) as Timeline;

  const now = Date.now();
  const state = (timeline.channels?.["client-events"]?.states ?? [])
    .filter((s) => Date.parse(s.validFrom) <= now)
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))[0];

  const rotation = new Map<string, Date | undefined>();
  for (const event of state?.activeEvents ?? []) {
    if (!event.eventType.startsWith(ROTATION_EVENT_PREFIX)) {
      continue;
    }
    const since = event.activeSince ? Date.parse(event.activeSince) : 0;
    const until = event.activeUntil ? Date.parse(event.activeUntil) : Infinity;
    if (since <= now && now < until) {
      rotation.set(
        event.eventType.slice(ROTATION_EVENT_PREFIX.length),
        Number.isFinite(until) ? new Date(until) : undefined,
      );
    }
  }
  if (rotation.size === 0) {
    throw new Error(`no ${ROTATION_EVENT_PREFIX}* events in the current timeline state`);
  }
  return rotation;
}
