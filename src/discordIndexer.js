import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_DELAY_MS = 1200;
const DEFAULT_MAX_RETRIES = 3;
const DATA_DIR = path.join(process.cwd(), 'data');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function extractAttachments(message) {
  return [...message.attachments.values()].map((attachment) => ({
    fileName: attachment.name ?? null,
    url: attachment.url,
    contentType: attachment.contentType ?? null,
    size: attachment.size
  }));
}

function serializeMessage(message) {
  return {
    messageId: message.id,
    channelId: message.channelId,
    authorId: message.author?.id ?? null,
    authorTag: message.author?.tag ?? 'utente sconosciuto',
    createdAt: message.createdAt?.toISOString() ?? null,
    content: message.content ?? '',
    attachments: extractAttachments(message)
  };
}

function getRetryDelay(error, fallbackDelayMs) {
  const retryAfterSeconds = error?.retryAfter ?? error?.rawError?.retry_after;

  if (typeof retryAfterSeconds === 'number') {
    return Math.ceil(retryAfterSeconds * 1000) + 500;
  }

  return fallbackDelayMs;
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

export async function indexChannelById(client, channelId, options = {}) {
  const channel = await client.channels.fetch(channelId);

  if (!channel) {
    throw new Error(`Canale ${channelId} non trovato o non accessibile dal bot.`);
  }

  return indexChannelMessages(channel, options);
}

export async function indexChannelMessages(channel, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxMessages = options.maxMessages ?? null;

  if (!channel?.messages?.fetch) {
    throw new Error('Il canale selezionato non supporta il recupero dei messaggi.');
  }

  const messages = [];
  let attachmentCount = 0;
  let before;
  let keepFetching = true;

  while (keepFetching) {
    const fetchLimit = maxMessages ? Math.min(batchSize, maxMessages - messages.length) : batchSize;

    if (fetchLimit <= 0) break;

    const fetchOptions = { limit: fetchLimit };
    if (before) fetchOptions.before = before;

    const batch = await fetchMessageBatch(channel, fetchOptions, { maxRetries, batchDelayMs });

    if (batch.size === 0) break;

    const orderedMessages = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of orderedMessages) {
      const serialized = serializeMessage(message);
      messages.push(serialized);
      attachmentCount += serialized.attachments.length;
    }

    before = batch.last()?.id;
    keepFetching = batch.size === fetchLimit;

    // Piccola pausa volontaria tra blocchi per non stressare le API Discord.
    if (keepFetching) {
      await wait(batchDelayMs);
    }
  }

  await mkdir(DATA_DIR, { recursive: true });

  const indexedAt = new Date().toISOString();
  const filePath = path.join(DATA_DIR, `${safeFileName(channel.id)}.json`);
  const payload = {
    channelId: channel.id,
    channelName: channel.name ?? null,
    indexedAt,
    messageCount: messages.length,
    attachmentCount,
    messages
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  return {
    channelId: channel.id,
    filePath,
    messageCount: messages.length,
    attachmentCount
  };
}
