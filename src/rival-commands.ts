import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  Events,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { INSTRUMENTS, type Instrument, isEpicConfigured, lookupEpicAccount } from "./epic.js";
import { getTrack, isInRotation, searchTracks } from "./festival.js";
import {
  addRivalry,
  boardName,
  buildRemoveRow,
  buildStandingEmbed,
  countRivalries,
  fetchStanding,
  getLink,
  listRivalries,
  removeRivalry,
  RIVAL_REMOVE_PREFIX,
  setLink,
} from "./rivals.js";

// Each rivalry is one leaderboard request an hour, so keep it bounded.
const MAX_RIVALRIES = 50;
const DEFAULT_INSTRUMENT: Instrument = "Solo_Vocals";
const RIVAL_COLOR = 0xff4d6d;

export const RIVAL_COMMANDS = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Epic account, for Fortnite Festival rivalries")
    .addStringOption((option) => option.setName("epic").setDescription("Your Epic display name").setRequired(true)),
  new SlashCommandBuilder()
    .setName("rival")
    .setDescription("Get a DM when another player passes your all-time score on a song")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Start a rivalry on one song and instrument")
        .addStringOption((option) => option.setName("player").setDescription("Their Epic display name").setRequired(true))
        .addStringOption((option) =>
          option.setName("song").setDescription("Song title or artist").setRequired(true).setAutocomplete(true),
        )
        .addStringOption((option) =>
          option
            .setName("instrument")
            .setDescription("Defaults to Vocals")
            .addChoices(...Object.entries(INSTRUMENTS).map(([value, name]) => ({ name, value }))),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("Your rivalries and where you stand")),
].map((command) =>
  command
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .toJSON(),
);

const fmt = (n: number) => n.toLocaleString("en-US");

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

async function handleLink(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString("epic", true).trim();
  const account = await lookupEpicAccount(name);
  if (!account) {
    await interaction.editReply({ content: `No Epic account is called **${name}**.` });
    return;
  }
  await setLink(interaction.user.id, account);
  await interaction.editReply({
    content: `🔗 Linked to **${account.displayName}**. Add a rival with \`/rival add\`.`,
  });
}

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = await getLink(interaction.user.id);
  if (!link) {
    await interaction.editReply({ content: "Link your Epic account first with `/link epic:<your name>`." });
    return;
  }
  if ((await countRivalries(interaction.user.id)) >= MAX_RIVALRIES) {
    await interaction.editReply({ content: `You're at the limit of ${MAX_RIVALRIES} rivalries. Remove one from \`/rival list\`.` });
    return;
  }

  const query = interaction.options.getString("song", true);
  const track = getTrack(query) ?? searchTracks(query, 1)[0];
  if (!track) {
    await interaction.editReply({ content: `No Jam Track matches **${query}**.` });
    return;
  }
  const instrument = (interaction.options.getString("instrument") ?? DEFAULT_INSTRUMENT) as Instrument;
  const playerName = interaction.options.getString("player", true).trim();
  const rival = await lookupEpicAccount(playerName);
  if (!rival) {
    await interaction.editReply({ content: `No Epic account is called **${playerName}**.` });
    return;
  }
  if (rival.id === link.accountId) {
    await interaction.editReply({ content: "That's you." });
    return;
  }

  const standing = await fetchStanding(track, instrument, link.accountId, rival.id);
  if (!standing) {
    await interaction.editReply({ content: `**${boardName(track, track.id, instrument)}** has no leaderboard.` });
    return;
  }
  const id = await addRivalry(interaction.user.id, rival, track, instrument, standing);
  await interaction.editReply({
    embeds: [buildStandingEmbed("added", track, instrument, link.displayName, rival.displayName, standing)],
    components: [buildRemoveRow(id)],
  });
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const link = await getLink(interaction.user.id);
  const rivalries = await listRivalries(interaction.user.id);
  if (rivalries.length === 0) {
    await interaction.editReply({
      content: link
        ? `Linked to **${link.displayName}**. No rivalries yet — add one with \`/rival add\`.`
        : "Link your Epic account with `/link`, then add a rival with `/rival add`.",
    });
    return;
  }

  const lines = rivalries.map((r) => {
    const board = `**${boardName(getTrack(r.trackId), r.trackId, r.instrument)}** vs ${r.rivalName}`;
    const gap = (r.rivalScore ?? 0) - (r.myScore ?? 0);
    const state = gap > 0 ? `🔻 ${fmt(gap)} behind` : gap < 0 ? `✅ ${fmt(-gap)} ahead` : "🤝 tied";
    const rank = r.myRank !== null ? ` · you #${fmt(r.myRank)}` : "";
    return `${board} — ${state}${rank}`;
  });
  const embed = new EmbedBuilder()
    .setColor(RIVAL_COLOR)
    .setAuthor({ name: "⚔️ Fortnite Festival · Your rivalries" })
    .setTitle(link ? `As ${link.displayName}` : "Not linked")
    .setDescription(truncate(lines.join("\n"), 4096))
    .setFooter({ text: "All-time scores, checked hourly · tap a rivalry below to stop it" });

  // 5 rows of 5 buttons.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  rivalries.slice(0, 25).forEach((r, i) => {
    if (i % 5 === 0) {
      rows.push(new ActionRowBuilder<ButtonBuilder>());
    }
    const title = getTrack(r.trackId)?.title ?? r.trackId;
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(`${RIVAL_REMOVE_PREFIX}:${r.id}`)
        .setLabel(truncate(`${title} · ${INSTRUMENTS[r.instrument]} · ${r.rivalName}`, 80))
        .setEmoji("🏳️")
        .setStyle(ButtonStyle.Secondary),
    );
  });
  await interaction.editReply({ embeds: [embed], components: rows });
}

export function registerRivalCommands(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    const isRivalCommand =
      interaction.isChatInputCommand() && (interaction.commandName === "link" || interaction.commandName === "rival");
    const isRemove = interaction.isButton() && interaction.customId.startsWith(`${RIVAL_REMOVE_PREFIX}:`);
    try {
      if (interaction.isAutocomplete() && interaction.commandName === "rival") {
        const tracks = searchTracks(interaction.options.getFocused());
        await interaction.respond(
          tracks.map((t) => ({
            name: truncate(`${isInRotation(t.id) ? "🟢 " : ""}${t.title} — ${t.artist}`, 100),
            value: t.id,
          })),
        );
        return;
      }
      if (!isRivalCommand && !isRemove) {
        return;
      }
      // Acknowledged first: Discord drops interactions after 3 seconds.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!isEpicConfigured()) {
        await interaction.editReply({ content: "Rivalries need the bot's Epic login, which isn't set up." });
        return;
      }

      if (interaction.isButton()) {
        const removed = await removeRivalry(interaction.user.id, Number(interaction.customId.split(":")[1]));
        await interaction.editReply({
          content: removed
            ? `🏳️ Stopped the rivalry with **${removed.rivalName}** on **${boardName(getTrack(removed.trackId), removed.trackId, removed.instrument)}**.`
            : "That rivalry is already gone.",
        });
      } else if (interaction.isChatInputCommand() && interaction.commandName === "link") {
        await handleLink(interaction);
      } else if (interaction.isChatInputCommand() && interaction.options.getSubcommand() === "add") {
        await handleAdd(interaction);
      } else if (interaction.isChatInputCommand()) {
        await handleList(interaction);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[rivals] interaction failed: ${message}`);
      if (interaction.isRepliable() && !interaction.replied) {
        const reply = { content: "Something went wrong — try again in a bit." };
        await (interaction.deferred
          ? interaction.followUp({ ...reply, flags: MessageFlags.Ephemeral })
          : interaction.reply({ ...reply, flags: MessageFlags.Ephemeral })
        ).catch(() => {});
      }
    }
  });
}
