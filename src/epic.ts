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

// Track id -> when it leaves the rotation, from the newest timeline state
// that's already in effect.
export async function fetchTimelineRotation(): Promise<Map<string, Date | undefined>> {
  const res = await fetch(TIMELINE_URL, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    token = undefined;
  }
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
