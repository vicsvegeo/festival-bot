import { Client, Events, GatewayIntentBits } from "discord.js";

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

export function createClient(): Client {
  return new Client({
    // Slash commands, buttons and outgoing DMs need nothing more.
    intents: [GatewayIntentBits.Guilds],
  });
}

export function registerConnectionLogging(client: Client): void {
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[discord] connected — logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.ShardDisconnect, (_event, shardId) => {
    console.warn(`[discord] shard ${shardId} disconnected`);
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    console.log(`[discord] shard ${shardId} reconnecting`);
  });

  client.on(Events.ShardResume, (shardId) => {
    console.log(`[discord] shard ${shardId} resumed`);
  });

  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[discord] shard ${shardId} error: ${error.message}`);
  });

  client.on(Events.Error, (error) => {
    console.error(`[discord] client error: ${error.message}`);
  });

  client.on(Events.Warn, (message) => {
    console.warn(`[discord] warning: ${message}`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// discord.js retries transient Gateway disconnects internally once a session
// exists; this loop only covers the initial login, which can fail on
// transient network errors before any shard/session is established.
export async function startBot(client: Client, token: string): Promise<void> {
  let delay = RECONNECT_BASE_DELAY_MS;
  for (;;) {
    try {
      await client.login(token);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[discord] login failed: ${message}`);
      console.log(`[discord] retrying login in ${delay / 1000}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
    }
  }
}
