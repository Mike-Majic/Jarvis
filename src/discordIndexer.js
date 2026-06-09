import { getSupabaseClient, SupabaseConfigError } from './supabaseClient.js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_DELAY_MS = 500;
const DEFAULT_MAX_MESSAGES = 5000;
const DEFAULT_MAX_RETRIES = 3;
const LOG_EVERY_MESSAGES = 500;
const SUPABASE_TABLE = 'discord_messages';
const SUPABASE_UPSERT_CHUNK_SIZE = 500;
const SUPABASE_READ_PAGE_SIZE = 1000;

function formatLogPrefix(scope) {
  return `[${new Date().toISOString()}] [${scope}]`;
}

function logInfo(scope, message, ...details) {
  console.log(`${formatLogPrefix(scope)} ${message}`, ...details);
}

function logWarn(scope, message, ...details) {
  console.warn(`${formatLogPrefix(scope)} ${message}`, ...details);
}

export class ChannelNotFetchableError extends Error {
  constructor() {
    super('Il canale selezionato non supporta il recupero dei messaggi.');
    this.name = 'ChannelNotFetchableError';
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(error, fallbackDelayMs) {
  const retryAfterSeconds = error?.retryAfter ?? error?.rawError?.retry_after;

  if (typeof retryAfterSeconds === 'number') {
    return Math.ceil(retryAfterSeconds * 1000) + 500;
  }

  return fallbackDelayMs;
}

function getChannelName(channel) {
  return channel.name ?? null;
}

function getGuildId(channel) {
  return channel.guildId ?? channel.guild?.id ?? null;
}

function getGuildName(channel) {
  return channel.guild?.name ?? null;
}

export function getChannelArchiveFilePath(channelId) {
  return `Supabase:${SUPABASE_TABLE}:channel_id=${channelId}`;
}

function extractAttachments(message) {
  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    name: attachment.name ?? null,
    url: attachment.url,
    contentType: attachment.contentType ?? null,
    size: attachment.size
  }));
}

function serializeMessage(message, channel, indexedAt) {
  return {
    guild_id: getGuildId(channel),
    guild_name: getGuildName(channel),
    channel_id: message.channelId,
    channel_name: getChannelName(channel),
    message_id: message.id,
    author_id: message.author?.id ?? null,
    author_tag: message.author?.tag ?? 'utente sconosciuto',
    created_at: message.createdAt?.toISOString() ?? null,
    content: message.content ?? '',
    attachments: extractAttachments(message),
    indexed_at: indexedAt
  };
}

async function fetchMessageBatch(channel, options, retryOptions) {
  let attempt = 0;

  while (attempt <= retryOptions.maxRetries) {
    try {
      return await channel.messages.fetch(options);
    } catch (error) {
      attempt += 1;

      if (attempt > retryOptions.maxRetries) {
        throw error;
      }

      const retryDelayMs = getRetryDelay(error, retryOptions.batchDelayMs * attempt);
      logWarn(
        'indexer:fetch',
        `Errore durante il recupero dei messaggi del canale ${channel.id}. Riprovo tra ${retryDelayMs} ms...`,
        error
      );
      await wait(retryDelayMs);
    }
  }

  return new Map();
}

async function upsertRows(rows) {
  if (rows.length === 0) return;

  const supabase = getSupabaseClient();

  for (let index = 0; index < rows.length; index += SUPABASE_UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(index, index + SUPABASE_UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from(SUPABASE_TABLE)
      .upsert(chunk, { onConflict: 'message_id' });

    if (error) throw error;
  }
}

function countAttachments(rows) {
  return rows.reduce((total, row) => {
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    return total + attachments.length;
  }, 0);
}

async function getChannelRowCount(channelId) {
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from(SUPABASE_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', channelId);

  if (error) throw error;
  return count ?? 0;
}

async function fetchAllArchiveRows(columns) {
  const supabase = getSupabaseClient();
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + SUPABASE_READ_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(SUPABASE_TABLE)
      .select(columns)
      .range(from, to);

    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);

    if (page.length < SUPABASE_READ_PAGE_SIZE) break;
    from += SUPABASE_READ_PAGE_SIZE;
  }

  return rows;
}

export async function getArchiveStatus() {
  const rows = await fetchAllArchiveRows(
    'guild_id,guild_name,channel_id,channel_name,message_id,attachments,indexed_at'
  );
  const channelsById = new Map();

  for (const row of rows) {
    const channelId = row.channel_id ?? 'canale_sconosciuto';
    const existing = channelsById.get(channelId) ?? {
      guildId: row.guild_id ?? null,
      guildName: row.guild_name ?? 'server sconosciuto',
      channelId,
      channelName: row.channel_name ?? 'canale sconosciuto',
      totalMessages: 0,
      totalAttachments: 0,
      indexedAt: null
    };

    existing.totalMessages += 1;
    existing.totalAttachments += Array.isArray(row.attachments) ? row.attachments.length : 0;

    if (row.indexed_at && (!existing.indexedAt || row.indexed_at > existing.indexedAt)) {
      existing.indexedAt = row.indexed_at;
    }

    channelsById.set(channelId, existing);
  }

  const channels = [...channelsById.values()].sort((a, b) => {
    const guildCompare = String(a.guildName).localeCompare(String(b.guildName));
    if (guildCompare !== 0) return guildCompare;
    return String(a.channelName).localeCompare(String(b.channelName));
  });

  return {
    storage: `Supabase:${SUPABASE_TABLE}`,
    totalChannels: channels.length,
    totalMessages: rows.length,
    totalAttachments: channels.reduce((total, channel) => total + channel.totalAttachments, 0),
    channels
  };
}

export async function deleteChannelArchive(channelId) {
  const supabase = getSupabaseClient();
  const existingRows = await getChannelRowCount(channelId);
  const { error } = await supabase
    .from(SUPABASE_TABLE)
    .delete()
    .eq('channel_id', channelId);

  if (error) throw error;

  return {
    deleted: existingRows > 0,
    deletedRows: existingRows,
    storage: `Supabase:${SUPABASE_TABLE}`,
    channelId
  };
}

export async function reindexChannelById(client, channelId, options = {}) {
  const deleteResult = await deleteChannelArchive(channelId);
  const indexResult = await indexChannelById(client, channelId, options);

  return {
    ...indexResult,
    deletedOldArchive: deleteResult.deleted,
    deletedRows: deleteResult.deletedRows
  };
}

export async function indexChannelById(client, channelId, options = {}) {
  const channel = await client.channels.fetch(channelId);

  if (!channel) {
    throw new Error(`Canale ${channelId} non trovato o non accessibile dal bot.`);
  }

  return indexChannelMessages(channel, options);
}

export async function indexChannelMessages(channel, options = {}) {
  const batchSize = DEFAULT_BATCH_SIZE;
  const batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const requestedMaxMessages = Number.parseInt(options.maxMessages ?? `${DEFAULT_MAX_MESSAGES}`, 10);
  const maxMessages = Number.isFinite(requestedMaxMessages) && requestedMaxMessages > 0
    ? requestedMaxMessages
    : DEFAULT_MAX_MESSAGES;

  if (!channel?.messages?.fetch) {
    throw new ChannelNotFetchableError();
  }

  const indexedAt = new Date().toISOString();
  let totalMessages = 0;
  let totalAttachments = 0;
  let before;
  let lastLoggedCount = 0;

  while (totalMessages < maxMessages) {
    const fetchLimit = Math.min(batchSize, maxMessages - totalMessages);
    const fetchOptions = { limit: fetchLimit };
    if (before) fetchOptions.before = before;

    const batch = await fetchMessageBatch(channel, fetchOptions, { maxRetries, batchDelayMs });

    if (batch.size === 0) break;

    const orderedMessages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const rows = orderedMessages.map((message) => serializeMessage(message, channel, indexedAt));

    await upsertRows(rows);

    totalMessages += rows.length;
    totalAttachments += countAttachments(rows);

    const oldestMessage = [...batch.values()].reduce((oldest, message) => {
      if (!oldest) return message;
      return message.createdTimestamp < oldest.createdTimestamp ? message : oldest;
    }, null);
    before = oldestMessage?.id;

    if (totalMessages - lastLoggedCount >= LOG_EVERY_MESSAGES) {
      lastLoggedCount = totalMessages;
      logInfo('indexer:progress', `Indicizzazione Supabase canale ${channel.id}: ${totalMessages} messaggi salvati...`);
    }

    if (!before || batch.size < fetchLimit) break;

    // Piccola pausa volontaria tra blocchi per ridurre il rischio di rate limit Discord.
    await wait(batchDelayMs);
  }

  return {
    channelId: channel.id,
    channelName: getChannelName(channel),
    guildId: getGuildId(channel),
    guildName: getGuildName(channel),
    storage: `Supabase:${SUPABASE_TABLE}`,
    totalMessages,
    totalAttachments
  };
}

export { SupabaseConfigError };
