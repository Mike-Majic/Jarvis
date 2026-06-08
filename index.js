import 'dotenv/config';
import { createServer } from 'node:http';
import { GoogleGenAI } from '@google/genai';
import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import {
  ChannelNotFetchableError,
  deleteChannelArchive,
  getArchiveStatus,
  indexChannelById,
  reindexChannelById
} from './src/discordIndexer.js';

const { DISCORD_TOKEN, GEMINI_API_KEY, GEMINI_MODEL = 'gemini-2.5-flash' } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Errore: DISCORD_TOKEN non è configurato nel file .env');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.error('Errore: GEMINI_API_KEY non è configurato nel file .env');
  process.exit(1);
}

const gemini = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Memoria conversazionale semplice in RAM, separata per canale.
// Nota: viene azzerata a ogni riavvio del bot.
const channelMemory = new Map();
const MAX_MEMORY_MESSAGES = 10;
const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_MESSAGE_LIMIT = 1900;
const INDEX_CHANNEL_COMMAND = 'jarvis indicizza questo canale';
const ARCHIVE_STATUS_COMMAND = 'jarvis stato archivio';
const DELETE_CHANNEL_ARCHIVE_COMMAND = 'jarvis cancella archivio questo canale';
const REINDEX_CHANNEL_COMMAND = 'jarvis reindicizza questo canale';
const DEFAULT_INDEX_MAX_MESSAGES = 5000;
const INDEX_MAX_MESSAGES = Number.parseInt(process.env.INDEX_MAX_MESSAGES ?? `${DEFAULT_INDEX_MAX_MESSAGES}`, 10);
const SAFE_INDEX_MAX_MESSAGES = Number.isFinite(INDEX_MAX_MESSAGES) && INDEX_MAX_MESSAGES > 0
  ? INDEX_MAX_MESSAGES
  : DEFAULT_INDEX_MAX_MESSAGES;
const RAW_PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const PORT = Number.isFinite(RAW_PORT) && RAW_PORT > 0 ? RAW_PORT : 3000;

function startHealthServer() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;

    if (path === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }

    if (path === '/') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Jarvis is running');
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`Health server in ascolto sulla porta ${PORT}`);
  });
}

function getNormalizedContent(message) {
  return (message.content ?? '').trim().toLowerCase();
}

function isIndexChannelCommand(message) {
  return getNormalizedContent(message) === INDEX_CHANNEL_COMMAND;
}

function isArchiveStatusCommand(message) {
  return getNormalizedContent(message) === ARCHIVE_STATUS_COMMAND;
}

function isDeleteChannelArchiveCommand(message) {
  return getNormalizedContent(message) === DELETE_CHANNEL_ARCHIVE_COMMAND;
}

function isReindexChannelCommand(message) {
  return getNormalizedContent(message) === REINDEX_CHANNEL_COMMAND;
}

function isArchiveCommand(message) {
  return isIndexChannelCommand(message)
    || isArchiveStatusCommand(message)
    || isDeleteChannelArchiveCommand(message)
    || isReindexChannelCommand(message);
}

function isAdministrator(message) {
  return Boolean(message.member?.permissions?.has(PermissionFlagsBits.Administrator));
}

async function ensureAdministrator(message) {
  if (isAdministrator(message)) return true;

  await message.reply({
    content: "Solo un amministratore può gestire l'archivio locale di Jarvis.",
    allowedMentions: { repliedUser: false }
  });
  return false;
}

function buildIndexErrorMessage(error) {
  if (error instanceof ChannelNotFetchableError) {
    return 'Questo canale non supporta il recupero dei messaggi storici.';
  }

  return 'Mi dispiace, non sono riuscito a indicizzare questo canale. Controlla che il bot abbia i permessi per vedere il canale e leggere la cronologia messaggi.';
}

async function replyWithChunks(message, content) {
  for (const chunk of splitDiscordMessage(content)) {
    await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
  }
}

async function handleIndexChannelCommand(message) {
  if (!(await ensureAdministrator(message))) return;

  try {
    await message.reply({
      content: 'Indicizzazione del canale avviata. Potrebbe richiedere qualche minuto...',
      allowedMentions: { repliedUser: false }
    });

    const result = await indexChannelById(client, message.channel.id, {
      maxMessages: SAFE_INDEX_MAX_MESSAGES
    });

    await message.reply({
      content: `Indicizzazione completata: ho salvato ${result.totalMessages} messaggi e trovato ${result.totalAttachments} allegati. File creato: ${result.filePath}`,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error("Errore durante l'indicizzazione del canale:", error);

    try {
      await message.reply({
        content: buildIndexErrorMessage(error),
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      console.error("Errore durante l'invio del messaggio di errore dell'indicizzazione:", replyError);
    }
  }
}

async function handleArchiveStatusCommand(message) {
  if (!(await ensureAdministrator(message))) return;

  try {
    const status = await getArchiveStatus();

    if (status.totalFiles === 0) {
      await message.reply({
        content: 'Archivio vuoto: non ho trovato file `channel_*.json` nella cartella `data/`.',
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    const lines = [
      `Archivio locale: ${status.totalFiles} file channel_*.json trovati in ${status.dataDir}.`,
      '',
      'Canali indicizzati:'
    ];

    for (const channel of status.channels) {
      const warning = channel.invalid ? ' ⚠️ file non leggibile' : '';
      lines.push(
        `- ${channel.channelName} (${channel.channelId}): ${channel.totalMessages} messaggi, ${channel.totalAttachments} allegati, ultima indicizzazione: ${channel.indexedAt ?? 'non disponibile'}.${warning}`
      );
    }

    await replyWithChunks(message, lines.join('\n'));
  } catch (error) {
    console.error("Errore durante la lettura dello stato dell'archivio:", error);
    await message.reply({
      content: "Non sono riuscito a leggere lo stato dell'archivio locale. Controlla i log del bot.",
      allowedMentions: { repliedUser: false }
    });
  }
}

async function handleDeleteChannelArchiveCommand(message) {
  if (!(await ensureAdministrator(message))) return;

  try {
    const result = await deleteChannelArchive(message.channel.id);

    if (result.deleted) {
      await message.reply({
        content: `Archivio del canale corrente cancellato: ${result.filePath}`,
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    await message.reply({
      content: `Nessun archivio da cancellare per questo canale. File non presente: ${result.filePath}`,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error("Errore durante la cancellazione dell'archivio del canale:", error);
    await message.reply({
      content: "Errore durante la cancellazione dell'archivio del canale. Controlla i log del bot.",
      allowedMentions: { repliedUser: false }
    });
  }
}

async function handleReindexChannelCommand(message) {
  if (!(await ensureAdministrator(message))) return;

  try {
    await message.reply({
      content: 'Reindicizzazione del canale avviata: cancello il vecchio JSON se presente e ricreo l\'archivio...',
      allowedMentions: { repliedUser: false }
    });

    const result = await reindexChannelById(client, message.channel.id, {
      maxMessages: SAFE_INDEX_MAX_MESSAGES
    });

    await message.reply({
      content: `Reindicizzazione completata: ho salvato ${result.totalMessages} messaggi e trovato ${result.totalAttachments} allegati. File creato: ${result.filePath}`,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error('Errore durante la reindicizzazione del canale:', error);

    try {
      await message.reply({
        content: buildIndexErrorMessage(error),
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      console.error("Errore durante l'invio del messaggio di errore della reindicizzazione:", replyError);
    }
  }
}

async function handleArchiveCommand(message) {
  if (isIndexChannelCommand(message)) {
    await handleIndexChannelCommand(message);
    return;
  }

  if (isArchiveStatusCommand(message)) {
    await handleArchiveStatusCommand(message);
    return;
  }

  if (isDeleteChannelArchiveCommand(message)) {
    await handleDeleteChannelArchiveCommand(message);
    return;
  }

  if (isReindexChannelCommand(message)) {
    await handleReindexChannelCommand(message);
  }
}

function shouldReply(message) {
  const content = message.content ?? '';
  const mentionsBot = client.user ? message.mentions.has(client.user.id) : false;
  const containsJarvis = /\bjarvis\b/i.test(content);

  return mentionsBot || containsJarvis;
}

function cleanUserPrompt(message) {
  let prompt = message.content ?? '';

  if (client.user) {
    prompt = prompt.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '');
  }

  // Rimuove il nome del bot quando viene usato come parola di attivazione.
  prompt = prompt.replace(/\bjarvis\b/gi, '').trim();

  return prompt || 'Rispondi come assistente AI in italiano.';
}

function getChannelHistory(channelId) {
  if (!channelMemory.has(channelId)) {
    channelMemory.set(channelId, []);
  }

  return channelMemory.get(channelId);
}

function rememberMessage(channelId, role, content) {
  const history = getChannelHistory(channelId);
  history.push({ role, content });

  if (history.length > MAX_MEMORY_MESSAGES) {
    history.splice(0, history.length - MAX_MEMORY_MESSAGES);
  }
}

function splitDiscordMessage(text) {
  const chunks = [];
  let remaining = text || 'Non ho ricevuto una risposta valida.';

  while (remaining.length > SAFE_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n', SAFE_MESSAGE_LIMIT);

    if (splitAt < SAFE_MESSAGE_LIMIT * 0.5) {
      splitAt = remaining.lastIndexOf(' ', SAFE_MESSAGE_LIMIT);
    }

    if (splitAt < SAFE_MESSAGE_LIMIT * 0.5) {
      splitAt = SAFE_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  // Ultima protezione: nessun chunk deve superare il limite reale di Discord.
  return chunks.map((chunk) => chunk.slice(0, DISCORD_MESSAGE_LIMIT));
}

function convertHistoryToGeminiContents(history, prompt) {
  return [
    ...history.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    })),
    {
      role: 'user',
      parts: [{ text: prompt }]
    }
  ];
}

function isGeminiQuotaOrApiKeyError(error) {
  const message = `${error?.message ?? ''} ${error?.status ?? ''} ${error?.code ?? ''}`.toLowerCase();
  return message.includes('quota')
    || message.includes('api key')
    || message.includes('apikey')
    || message.includes('permission')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('429')
    || message.includes('401')
    || message.includes('403');
}

async function askGemini(channelId, prompt) {
  const history = getChannelHistory(channelId);

  try {
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: convertHistoryToGeminiContents(history, prompt),
      config: {
        systemInstruction:
          'Sei Jarvis, un assistente AI dentro Discord. Rispondi sempre in italiano, in modo chiaro, pratico e utile. Se non sai qualcosa, dillo chiaramente e chiedi dettagli.',
        temperature: 0.4
      }
    });

    return response.text?.trim() || 'Mi dispiace, non sono riuscito a generare una risposta.';
  } catch (error) {
    if (isGeminiQuotaOrApiKeyError(error)) {
      console.error('Errore Gemini API key/quota:', error);
    } else {
      console.error('Errore durante la chiamata a Gemini:', error);
    }

    throw error;
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Jarvis è online come ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignora messaggi di altri bot per evitare loop o risposte indesiderate.
  if (message.author.bot) return;

  if (isArchiveCommand(message)) {
    await handleArchiveCommand(message);
    return;
  }

  if (!shouldReply(message)) return;

  const prompt = cleanUserPrompt(message);

  try {
    await message.channel.sendTyping();

    const reply = await askGemini(message.channel.id, prompt);

    rememberMessage(message.channel.id, 'user', prompt);
    rememberMessage(message.channel.id, 'assistant', reply);

    for (const chunk of splitDiscordMessage(reply)) {
      await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  } catch (error) {
    console.error('Errore durante la gestione del messaggio:', error);

    try {
      await message.reply({
        content: 'Mi dispiace, si è verificato un errore mentre elaboravo la richiesta. Riprova tra poco.',
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      console.error('Errore durante l\'invio del messaggio di errore:', replyError);
    }
  }
});

startHealthServer();

client.login(DISCORD_TOKEN).catch((error) => {
  console.error('Errore durante il login del bot Discord:', error);
  process.exit(1);
});
