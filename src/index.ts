import "dotenv/config";
import { createClient, registerConnectionLogging, startBot } from "./bot.js";
import { testConnection } from "./db.js";
import { startFestivalWatcher } from "./festival.js";
import { registerFestivalCommands } from "./festival-commands.js";
import { registerRivalCommands } from "./rival-commands.js";
import { startRivalWatcher } from "./rivals.js";

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("DISCORD_BOT_TOKEN environment variable is not set");
    process.exit(1);
  }

  try {
    await testConnection();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[db] connection check failed: ${message}`);
  }

  const client = createClient();
  registerConnectionLogging(client);
  registerFestivalCommands(client);
  registerRivalCommands(client);
  await startBot(client, token);

  startFestivalWatcher(client).catch((err) => {
    console.error("[festival] watcher failed to start", err);
  });
  startRivalWatcher(client).catch((err) => {
    console.error("[rivals] watcher failed to start", err);
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandled rejection]", reason);
});

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
