import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_DELAY_MS = 500;
const DEFAULT_MAX_MESSAGES = 5000;
const DEFAULT_MAX_RETRIES = 3;
const LOG_EVERY_MESSAGES = 500;
const DATA_DIR = path.join(process.cwd(), 'data');

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

export function getChannelArchiveFilePath(channelId) {
  return getOutputFilePath(channelId);
}

function getOutputFilePath(channelId) {
  return path.join(DATA_DIR, `channel_${channelId}.json`);
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

function serializeMessage(message, channel) {
  return {
    messageId: message.id,
    channelId: message.channelId,
    channelName: getChannelName(channel),
    guildId: getGuildId(channel),
    authorId: message.author?.id ?? null,
    authorTag: message.author?.tag ?? 'utente sconosciuto',
    createdAt: message.createdAt?.toISOString() ?? null,
    content: message.content ?? '',
    attachments: extractAttachments(message)
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
      console.warn(
        `Errore durante il recupero dei messaggi del canale ${channel.id}. Riprovo tra ${retryDelayMs} ms...`,
        error
      );
      await wait(retryDelayMs);
    }
  }

  return new Map();
}


export async function getArchiveStatus() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const fileNames = await readdir(DATA_DIR);
    const channelFiles = fileNames
      .filter((fileName) => /^channel_\d+\.json$/.test(fileName))
      .sort();

    const channels = [];

    for (const fileName of channelFiles) {
      const filePath = path.join(DATA_DIR, fileName);

      try {
        const rawContent = await readFile(filePath, 'utf8');
        const data = JSON.parse(rawContent);

        channels.push({
          fileName,
          filePath,
          channelId: data.channelId ?? fileName.replace(/^channel_/, '').replace(/\.json$/, ''),
          channelName: data.channelName ?? 'canale sconosciuto',
          totalMessages: data.totalMessages ?? data.messageCount ?? 0,
          totalAttachments: data.totalAttachments ?? data.attachmentCount ?? 0,
          indexedAt: data.indexedAt ?? null
        });
      } catch (error) {
        console.warn(`Archivio ${fileName} non leggibile o non valido:`, error);
        channels.push({
          fileName,
          filePath,
          channelId: fileName.replace(/^channel_/, '').replace(/\.json$/, ''),
          channelName: 'archivio non leggibile',
          totalMessages: 0,
          totalAttachments: 0,
          indexedAt: null,
          invalid: true
        });
      }
    }

    return {
      dataDir: DATA_DIR,
      totalFiles: channelFiles.length,
      channels
    };
  } catch (error) {
    throw new Error(`Impossibile leggere la cartella data/: ${error.message}`);
  }
}

export async function deleteChannelArchive(channelId) {
  await mkdir(DATA_DIR, { recursive: true });

  const filePath = getOutputFilePath(channelId);

  try {
    await rm(filePath);
    return { deleted: true, filePath };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { deleted: false, filePath, notFound: true };
    }

    throw error;
  }
}

export async function reindexChannelById(client, channelId, options = {}) {
  const deleteResult = await deleteChannelArchive(channelId);
  const indexResult = await indexChannelById(client, channelId, options);

  return {
    ...indexResult,
    deletedOldArchive: deleteResult.deleted
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

  const messages = [];
  let totalAttachments = 0;
  let before;
  let lastLoggedCount = 0;

  while (messages.length < maxMessages) {
    const fetchLimit = Math.min(batchSize, maxMessages - messages.length);
    const fetchOptions = { limit: fetchLimit };
    if (before) fetchOptions.before = before;

    const batch = await fetchMessageBatch(channel, fetchOptions, { maxRetries, batchDelayMs });

    if (batch.size === 0) break;

    const orderedMessages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of orderedMessages) {
      const serialized = serializeMessage(message, channel);
      messages.push(serialized);
      totalAttachments += serialized.attachments.length;
    }

    const oldestMessage = [...batch.values()].reduce((oldest, message) => {
      if (!oldest) return message;
      return message.createdTimestamp < oldest.createdTimestamp ? message : oldest;
    }, null);
    before = oldestMessage?.id;

    if (!before || batch.size < fetchLimit) break;

    if (messages.length - lastLoggedCount >= LOG_EVERY_MESSAGES) {
      lastLoggedCount = messages.length;
      console.log(`Indicizzazione canale ${channel.id}: ${messages.length} messaggi elaborati...`);
    }

    // Piccola pausa volontaria tra blocchi per ridurre il rischio di rate limit Discord.
    await wait(batchDelayMs);
  }

  await mkdir(DATA_DIR, { recursive: true });

  const filePath = getOutputFilePath(channel.id);
  const payload = {
    indexedAt: new Date().toISOString(),
    channelId: channel.id,
    channelName: getChannelName(channel),
    guildId: getGuildId(channel),
    totalMessages: messages.length,
    totalAttachments,
    messages
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  return {
    channelId: channel.id,
    filePath,
    totalMessages: messages.length,
    totalAttachments
  };
}
