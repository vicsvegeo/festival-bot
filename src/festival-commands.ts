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
  type Interaction,
  type InteractionUpdateOptions,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import {
  ARTIST_QUERY_PREFIX,
  type ArtistSort,
  buildTrackEmbed,
  buildUnsubscribeRow,
  type CatalogView,
  FESTIVAL_COLOR,
  getArtistName,
  getTrack,
  hasReleaseAlerts,
  isInRotation,
  listArtists,
  listSubscriptions,
  listTracks,
  RELEASE_ALERTS_PREFIX,
  rotationEndsAt,
  searchTracks,
  sendPreview,
  setReleaseAlerts,
  SUBSCRIBE_PREFIX,
  subscribe,
  type Track,
  UNSUBSCRIBE_PREFIX,
  unsubscribe,
} from "./festival.js";

const CATALOG_PREFIX = "festcat";
const ARTISTS_PREFIX = "festart";
// A select menu holds at most 25 options, so that's a page.
const PAGE_SIZE = 25;
const VIEWS: { view: CatalogView; label: string; emoji: string; title: string }[] = [
  { view: "all", label: "All", emoji: "🎵", title: "All Jam Tracks" },
  { view: "rotation", label: "Rotation", emoji: "🟢", title: "In the free rotation" },
  { view: "new", label: "Newest", emoji: "🆕", title: "Newest releases" },
];
const ARTIST_SORTS: { sort: ArtistSort; label: string; emoji: string; title: string }[] = [
  { sort: "count", label: "Most songs", emoji: "🔢", title: "Most songs" },
  { sort: "name", label: "A–Z", emoji: "🔤", title: "A–Z" },
];

const COMMANDS = [
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("Get a DM when a Fortnite Festival song enters the free rotation")
    .addStringOption((option) =>
      option.setName("song").setDescription("Song title or artist").setRequired(true).setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("catalog")
    .setDescription("Browse the Fortnite Festival Jam Tracks and pick songs to subscribe to")
    .addStringOption((option) =>
      option
        .setName("view")
        .setDescription("Which songs to list")
        .addChoices(...VIEWS.map(({ view, title }) => ({ name: title, value: view }))),
    )
    .addStringOption((option) =>
      option.setName("search").setDescription("Filter by title or artist, or artist:<name> for one artist's songs"),
    ),
  new SlashCommandBuilder()
    .setName("artists")
    .setDescription("Browse Fortnite Festival artists by number of Jam Tracks, then pick one to see their songs")
    .addStringOption((option) =>
      option
        .setName("sort")
        .setDescription("How to order the artists")
        .addChoices(...ARTIST_SORTS.map(({ sort, title }) => ({ name: title, value: sort }))),
    )
    .addStringOption((option) => option.setName("search").setDescription("Filter by artist name")),
  new SlashCommandBuilder()
    .setName("subscriptions")
    .setDescription("List the Fortnite Festival songs you're subscribed to"),
  // Local testing only: DMs a sample of every alert.
  ...(process.env.FESTIVAL_PREVIEW === "1"
    ? [new SlashCommandBuilder().setName("festival-preview").setDescription("DM me a sample of every Festival alert")]
    : []),
].map((command) =>
  command
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .toJSON(),
);

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function trackNames(tracks: Track[]): string {
  return truncate(tracks.map((t) => `**${t.title}**`).join(", "), 1500);
}

// Custom ids carry the whole catalog state, so any click can re-render the
// page without server-side sessions: festcat:<action>:<view>:<page>:<query>.
function catalogId(action: string, view: CatalogView, page: number, query: string): string {
  return `${CATALOG_PREFIX}:${action}:${view}:${page}:${query}`.slice(0, 100);
}

function parseCatalogId(customId: string): { action: string; view: CatalogView; page: number; query: string } {
  const [, action, view, page, ...rest] = customId.split(":");
  return {
    action,
    view: VIEWS.some((v) => v.view === view) ? (view as CatalogView) : "all",
    page: Number(page) || 0,
    query: rest.join(":"),
  };
}

async function renderCatalog(
  userId: string,
  view: CatalogView,
  requestedPage: number,
  query: string,
  notice?: string,
): Promise<InteractionUpdateOptions> {
  // The custom id budget leaves room for ~60 characters of search text.
  query = query.slice(0, 60);
  const tracks = listTracks(view, query);
  const pageCount = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageTracks = tracks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const subscribed = new Set(await listSubscriptions(userId));
  const { title } = VIEWS.find((v) => v.view === view)!;
  const artistKey = query.startsWith(ARTIST_QUERY_PREFIX) ? query.slice(ARTIST_QUERY_PREFIX.length) : undefined;
  const artistName = artistKey !== undefined ? (getArtistName(artistKey) ?? artistKey) : undefined;
  let heading = title;
  if (artistName) {
    heading = view === "all" ? `Songs by ${artistName}` : `${title} · ${artistName}`;
  } else if (query) {
    heading = `${title} matching “${query}”`;
  }

  const lines = pageTracks.map((t) => {
    const marker = subscribed.has(t.id) ? "🔔" : isInRotation(t.id) ? "🟢" : "▫️";
    const released =
      view === "new" && t.releasedAt ? ` · <t:${Math.floor(Date.parse(t.releasedAt) / 1000)}:d>` : "";
    return `${marker} **${t.title}** — ${t.artist}${released}`;
  });
  const embed = new EmbedBuilder()
    .setColor(FESTIVAL_COLOR)
    .setAuthor({ name: "🎸 Fortnite Festival · Jam Track catalog" })
    .setTitle(heading)
    .setDescription(truncate(lines.join("\n") || "No songs match.", 4096))
    .setFooter({
      text: `Page ${page + 1}/${pageCount} · ${tracks.length} songs · 🟢 in rotation · 🔔 subscribed`,
    });

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (pageTracks.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(catalogId("sel", view, page, query))
          .setPlaceholder("🔔 Pick songs to subscribe to…")
          .setMinValues(1)
          .setMaxValues(pageTracks.length)
          .addOptions(
            pageTracks.map((t) => ({
              label: truncate(t.title, 100),
              description: truncate(`${subscribed.has(t.id) ? "Subscribed · " : ""}${t.artist}`, 100) || undefined,
              emoji: subscribed.has(t.id) ? "🔔" : isInRotation(t.id) ? "🟢" : undefined,
              value: t.id,
            })),
          ),
      ),
    );
  }
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(catalogId("prev", view, page - 1, query))
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(catalogId("next", view, page + 1, query))
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pageCount - 1),
    ...VIEWS.map((v) =>
      new ButtonBuilder()
        .setCustomId(catalogId(`view${v.view}`, v.view, 0, query))
        .setLabel(v.label)
        .setEmoji(v.emoji)
        .setStyle(v.view === view ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(v.view === view),
    ),
  );
  components.push(nav);
  if (artistKey !== undefined) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(artistsId("back", "count", 0, ""))
          .setLabel("Artists")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return { content: notice ?? "", embeds: [embed], components };
}

// Same scheme as the catalog: festart:<action>:<sort>:<page>:<query>.
function artistsId(action: string, sort: ArtistSort, page: number, query: string): string {
  return `${ARTISTS_PREFIX}:${action}:${sort}:${page}:${query}`.slice(0, 100);
}

function parseArtistsId(customId: string): { action: string; sort: ArtistSort; page: number; query: string } {
  const [, action, sort, page, ...rest] = customId.split(":");
  return {
    action,
    sort: sort === "name" ? "name" : "count",
    page: Number(page) || 0,
    query: rest.join(":"),
  };
}

function renderArtists(sort: ArtistSort, requestedPage: number, query: string): InteractionUpdateOptions {
  query = query.slice(0, 60);
  const artists = listArtists(sort, query);
  const pageCount = Math.max(1, Math.ceil(artists.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const pageArtists = artists.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const songCount = (n: number) => `${n} song${n === 1 ? "" : "s"}`;

  const lines = pageArtists.map((a) => {
    const rotation = a.inRotation > 0 ? ` · 🟢 ${a.inRotation} in rotation` : "";
    return `**${a.name}** — ${songCount(a.songs)}${rotation}`;
  });
  const embed = new EmbedBuilder()
    .setColor(FESTIVAL_COLOR)
    .setAuthor({ name: "🎸 Fortnite Festival · Artists" })
    .setTitle(query ? `Artists matching “${query}”` : `Artists · ${ARTIST_SORTS.find((s) => s.sort === sort)!.title}`)
    .setDescription(truncate(lines.join("\n") || "No artists match.", 4096))
    .setFooter({
      text: `Page ${page + 1}/${pageCount} · ${artists.length} artists · collaborations count for every artist on them`,
    });

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (pageArtists.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(artistsId("pick", sort, page, query))
          .setPlaceholder("🎤 Pick an artist to see their songs…")
          .addOptions(
            pageArtists.map((a) => ({
              label: truncate(a.name, 100),
              description: `${songCount(a.songs)}${a.inRotation > 0 ? ` · ${a.inRotation} in rotation` : ""}`,
              value: a.key.slice(0, 100),
            })),
          ),
      ),
    );
  }
  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(artistsId("prev", sort, page - 1, query))
        .setEmoji("◀️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(artistsId("next", sort, page + 1, query))
        .setEmoji("▶️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
      ...ARTIST_SORTS.map((s) =>
        new ButtonBuilder()
          .setCustomId(artistsId(`sort${s.sort}`, s.sort, 0, query))
          .setLabel(s.label)
          .setEmoji(s.emoji)
          .setStyle(s.sort === sort ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(s.sort === sort),
      ),
    ),
  );

  return { content: "", embeds: [embed], components };
}

async function handleSubscribe(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = interaction.options.getString("song", true);
  // Autocomplete sends the track id; someone who types without picking
  // gets the best text match instead.
  const track = getTrack(query) ?? searchTracks(query, 1)[0];
  if (!track) {
    await interaction.editReply({ content: `No Jam Track matches **${query}**.` });
    return;
  }

  const added = (await subscribe(interaction.user.id, [track.id])) > 0;
  const name = `**${track.title}** by ${track.artist}`;
  const status = added ? `🔔 Subscribed to ${name}.` : `You're already subscribed to ${name}.`;

  if (isInRotation(track.id)) {
    await interaction.editReply({
      content: `${status} It's in the free rotation right now:`,
      embeds: [buildTrackEmbed(track)],
      components: [buildUnsubscribeRow(track.id)],
    });
    return;
  }
  await interaction.editReply({
    content: `${status} I'll DM you when it enters the free rotation.`,
    components: [buildUnsubscribeRow(track.id)],
  });
}

async function handleSubscriptions(interaction: ChatInputCommandInteraction): Promise<void> {
  const tracks = (await listSubscriptions(interaction.user.id))
    .map((id) => getTrack(id))
    .filter((t) => t !== undefined);
  const releaseAlerts = await hasReleaseAlerts(interaction.user.id);
  const releaseToggle = new ButtonBuilder()
    .setCustomId(`${RELEASE_ALERTS_PREFIX}:${releaseAlerts ? "off" : "on"}`)
    .setLabel(releaseAlerts ? "New-song alerts: on" : "New-song alerts: off")
    .setEmoji(releaseAlerts ? "🔔" : "🔕")
    .setStyle(releaseAlerts ? ButtonStyle.Success : ButtonStyle.Secondary);

  if (tracks.length === 0) {
    await interaction.editReply({
      content: "You're not subscribed to any songs yet. Try `/catalog` or `/subscribe`.",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(releaseToggle)],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(FESTIVAL_COLOR)
    .setAuthor({ name: "🎸 Fortnite Festival · Your subscriptions" })
    .setDescription(
      truncate(
        tracks
          .map((t) => {
            const until = rotationEndsAt(t.id);
            const leaves = until ? ` · leaves <t:${Math.floor(until.getTime() / 1000)}:R>` : "";
            return `${isInRotation(t.id) ? "🟢" : "⚪"} **${t.title}** — ${t.artist}${leaves}`;
          })
          .join("\n"),
        4096,
      ),
    )
    .setFooter({ text: "🟢 in the free rotation now · tap a song below to unsubscribe" });

  // Discord allows 5 rows of 5 buttons; the last row keeps a slot for the
  // new-song toggle, so 24 songs fit.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  tracks.slice(0, 24).forEach((t, i) => {
    if (i % 5 === 0) {
      rows.push(new ActionRowBuilder<ButtonBuilder>());
    }
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(`${UNSUBSCRIBE_PREFIX}:${t.id}`)
        .setLabel(truncate(t.title, 80))
        .setEmoji("🔕")
        .setStyle(ButtonStyle.Secondary),
    );
  });
  if (rows.length === 0 || rows[rows.length - 1].components.length === 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>());
  }
  rows[rows.length - 1].addComponents(releaseToggle);

  await interaction.editReply({ embeds: [embed], components: rows });
}

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));
const COMPONENT_PREFIXES = [CATALOG_PREFIX, ARTISTS_PREFIX, SUBSCRIBE_PREFIX, RELEASE_ALERTS_PREFIX, UNSUBSCRIBE_PREFIX];

// Commands and components this module answers; autocomplete is excluded since
// it can't be deferred.
function isFestivalInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand()) {
    return COMMAND_NAMES.has(interaction.commandName);
  }
  if (interaction.isMessageComponent()) {
    return COMPONENT_PREFIXES.some((p) => interaction.customId === p || interaction.customId.startsWith(`${p}:`));
  }
  return false;
}

export function registerFestivalCommands(client: Client): void {
  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.set(COMMANDS);
      console.log(`[festival] registered ${COMMANDS.length} slash commands`);
    } catch (err) {
      console.error(`[festival] command registration failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // Discord drops any interaction not acknowledged within 3 seconds, so
      // ours are acknowledged before any database or network work.
      if (isFestivalInteraction(interaction)) {
        // Catalog and artist pages edit themselves in place; everything else
        // answers with a new private message.
        const pages = [`${CATALOG_PREFIX}:`, `${ARTISTS_PREFIX}:`];
        if (interaction.isMessageComponent() && pages.some((p) => interaction.customId.startsWith(p))) {
          await interaction.deferUpdate();
        } else if (interaction.isRepliable()) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
      }

      if (interaction.isAutocomplete() && interaction.commandName === "subscribe") {
        const tracks = searchTracks(interaction.options.getFocused());
        await interaction.respond(
          tracks.map((t) => ({
            name: truncate(`${isInRotation(t.id) ? "🟢 " : ""}${t.title} — ${t.artist}`, 100),
            value: t.id,
          })),
        );
      } else if (interaction.isChatInputCommand() && interaction.commandName === "subscribe") {
        await handleSubscribe(interaction);
      } else if (interaction.isChatInputCommand() && interaction.commandName === "catalog") {
        const view = (interaction.options.getString("view") ?? "all") as CatalogView;
        const query = interaction.options.getString("search") ?? "";
        const page = await renderCatalog(interaction.user.id, view, 0, query);
        await interaction.editReply({ ...page, content: page.content || undefined });
      } else if (interaction.isChatInputCommand() && interaction.commandName === "artists") {
        const sort = (interaction.options.getString("sort") ?? "count") as ArtistSort;
        const page = renderArtists(sort, 0, interaction.options.getString("search") ?? "");
        await interaction.editReply({ ...page, content: page.content || undefined });
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith(`${ARTISTS_PREFIX}:`)) {
        const query = `${ARTIST_QUERY_PREFIX}${interaction.values[0]}`;
        await interaction.editReply(await renderCatalog(interaction.user.id, "all", 0, query));
      } else if (interaction.isButton() && interaction.customId.startsWith(`${ARTISTS_PREFIX}:`)) {
        const { sort, page, query } = parseArtistsId(interaction.customId);
        await interaction.editReply(renderArtists(sort, page, query));
      } else if (interaction.isChatInputCommand() && interaction.commandName === "festival-preview") {
        const sent = await sendPreview(interaction.client, interaction.user.id);
        await interaction.editReply({ content: `Sent ${sent} sample alerts to your DMs.` });
      } else if (interaction.isChatInputCommand() && interaction.commandName === "subscriptions") {
        await handleSubscriptions(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith(`${CATALOG_PREFIX}:`)) {
        const { view, page, query } = parseCatalogId(interaction.customId);
        await interaction.editReply(await renderCatalog(interaction.user.id, view, page, query));
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith(`${CATALOG_PREFIX}:`)) {
        const { view, page, query } = parseCatalogId(interaction.customId);
        const tracks = interaction.values.map((id) => getTrack(id)).filter((t) => t !== undefined);
        await subscribe(interaction.user.id, tracks.map((t) => t.id));
        await interaction.editReply(
          await renderCatalog(interaction.user.id, view, page, query, `🔔 Subscribed to ${trackNames(tracks)}.`),
        );
      } else if (interaction.isStringSelectMenu() && interaction.customId === SUBSCRIBE_PREFIX) {
        const tracks = interaction.values.map((id) => getTrack(id)).filter((t) => t !== undefined);
        await subscribe(interaction.user.id, tracks.map((t) => t.id));
        await interaction.editReply({
          content: `🔔 You'll get a DM when ${trackNames(tracks)} enter${tracks.length === 1 ? "s" : ""} the free rotation.`,
        });
      } else if (interaction.isButton() && interaction.customId.startsWith(`${RELEASE_ALERTS_PREFIX}:`)) {
        const enabled = interaction.customId.endsWith(":on");
        await setReleaseAlerts(interaction.user.id, enabled);
        await interaction.editReply({
          content: enabled
            ? "🔔 You'll get a DM whenever a new Jam Track is released."
            : "🔕 No more new-song alerts. Turn them back on from `/subscriptions`.",
        });
      } else if (interaction.isButton() && interaction.customId.startsWith(`${UNSUBSCRIBE_PREFIX}:`)) {
        const trackId = interaction.customId.slice(UNSUBSCRIBE_PREFIX.length + 1);
        const removed = await unsubscribe(interaction.user.id, trackId);
        const title = getTrack(trackId)?.title ?? trackId;
        await interaction.editReply({
          content: removed ? `🔕 Unsubscribed from **${title}**.` : `You weren't subscribed to **${title}**.`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[festival] interaction failed: ${message}`);
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
