import 'dotenv/config';
import { createServer } from 'node:http';
import { GoogleGenAI } from '@google/genai';
import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import {
  ChannelNotFetchableError,
  deleteChannelArchive,
  getArchiveStatus,
  indexChannelById,
  reindexChannelById,
  SupabaseConfigError
} from './src/discordIndexer.js';
import {
  formatArchiveResultsForDiscord,
  formatArchiveResultsForGemini,
  searchArchive
} from './src/archiveSearch.js';

function formatLogPrefix(scope) {
  return `[${new Date().toISOString()}] [${scope}]`;
}

function logInfo(scope, message, ...details) {
  console.log(`${formatLogPrefix(scope)} ${message}`, ...details);
}

function logWarn(scope, message, ...details) {
  console.warn(`${formatLogPrefix(scope)} ${message}`, ...details);
}

function logError(scope, message, ...details) {
  console.error(`${formatLogPrefix(scope)} ${message}`, ...details);
}

const { DISCORD_TOKEN, GEMINI_API_KEY, GEMINI_MODEL = 'gemini-2.5-flash' } = process.env;

if (!DISCORD_TOKEN) {
  logError('config', 'Errore: DISCORD_TOKEN non è configurato nel file .env');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  logError('config', 'Errore: GEMINI_API_KEY non è configurato nel file .env');
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
const ARCHIVE_SEARCH_COMMAND_PREFIX = 'jarvis cerca archivio';
const ARCHIVE_VERIFY_COMMAND_PREFIX = 'jarvis verifica archivio';
const DEFAULT_INDEX_MAX_MESSAGES = 5000;
const INDEX_MAX_MESSAGES = Number.parseInt(process.env.INDEX_MAX_MESSAGES ?? `${DEFAULT_INDEX_MAX_MESSAGES}`, 10);
const SAFE_INDEX_MAX_MESSAGES = Number.isFinite(INDEX_MAX_MESSAGES) && INDEX_MAX_MESSAGES > 0
  ? INDEX_MAX_MESSAGES
  : DEFAULT_INDEX_MAX_MESSAGES;
const RAW_PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const PORT = Number.isFinite(RAW_PORT) && RAW_PORT > 0 ? RAW_PORT : 3000;
const DISCORD_DIAGNOSTICS_INTERVAL_MS = 60_000;

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
    logInfo('health', `Health server in ascolto sulla porta ${PORT}`);
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

function isArchiveSearchCommand(message) {
  const content = getNormalizedContent(message);
  return content.startsWith(`${ARCHIVE_SEARCH_COMMAND_PREFIX} `)
    || content === ARCHIVE_SEARCH_COMMAND_PREFIX
    || content.startsWith(`${ARCHIVE_VERIFY_COMMAND_PREFIX} `)
    || content === ARCHIVE_VERIFY_COMMAND_PREFIX;
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
    content: "Solo un amministratore può gestire l'archivio Supabase di Jarvis.",
    allowedMentions: { repliedUser: false }
  });
  return false;
}

function buildSupabaseConfigErrorMessage(error) {
  if (error instanceof SupabaseConfigError) {
    return 'Supabase non è configurato: imposta SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nelle variabili ambiente di Render.';
  }

  return null;
}

function buildIndexErrorMessage(error) {
  if (error instanceof ChannelNotFetchableError) {
    return 'Questo canale non supporta il recupero dei messaggi storici.';
  }

  const supabaseConfigMessage = buildSupabaseConfigErrorMessage(error);
  if (supabaseConfigMessage) return supabaseConfigMessage;

  return 'Mi dispiace, non sono riuscito a indicizzare questo canale. Controlla che il bot abbia i permessi Discord e che Supabase sia configurato correttamente.';
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
      content: `Indicizzazione completata: ho salvato ${result.totalMessages} messaggi e trovato ${result.totalAttachments} allegati su Supabase (${result.storage}).`,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    logError('archive:index', "Errore durante l'indicizzazione del canale:", error);

    try {
      await message.reply({
        content: buildIndexErrorMessage(error),
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      logError('archive:index', "Errore durante l'invio del messaggio di errore dell'indicizzazione:", replyError);
    }
  }
}

async function handleArchiveStatusCommand(message) {
  if (!(await ensureAdministrator(message))) return;

  try {
    const status = await getArchiveStatus();

    if (status.totalChannels === 0) {
      await message.reply({
        content: 'Archivio Supabase vuoto: non ho trovato messaggi indicizzati nella tabella `discord_messages`.',
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    const lines = [
      `Archivio Supabase: ${status.totalChannels} canali indicizzati in ${status.storage}.`,
      `Totale messaggi: ${status.totalMessages}. Totale allegati: ${status.totalAttachments}.`,
      '',
      'Canali indicizzati:'
    ];

    for (const channel of status.channels) {
      lines.push(
        `- ${channel.guildName} / #${channel.channelName} (${channel.channelId}): ${channel.totalMessages} messaggi, ${channel.totalAttachments} allegati, ultima indicizzazione: ${channel.indexedAt ?? 'non disponibile'}.`
      );
    }

    await replyWithChunks(message, lines.join('\n'));
  } catch (error) {
    logError('archive:status', "Errore durante la lettura dello stato dell'archivio:", error);
    await message.reply({
      content: buildSupabaseConfigErrorMessage(error) ?? "Non sono riuscito a leggere lo stato dell'archivio Supabase. Controlla i log del bot.",
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
        content: `Archivio Supabase del canale corrente cancellato: ${result.deletedRows} righe rimosse da ${result.storage}.`,
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    await message.reply({
      content: 'Nessun archivio Supabase da cancellare per questo canale: non ho trovato righe con questo channel_id.',
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    logError('archive:delete', "Errore durante la cancellazione dell'archivio del canale:", error);
    await message.reply({
      content: buildSupabaseConfigErrorMessage(error) ?? "Errore durante la cancellazione dell'archivio del canale. Controlla i log del bot.",
      allowedMentions: { repliedUser: false }
    });
  }
}

async function handleReindexChannelCommand(message) {
  if (!(await ensureAdministrator(message))) return;

  try {
    await message.reply({
      content: "Reindicizzazione del canale avviata: cancello da Supabase le vecchie righe del canale corrente e ricreo l'archivio...",
      allowedMentions: { repliedUser: false }
    });

    const result = await reindexChannelById(client, message.channel.id, {
      maxMessages: SAFE_INDEX_MAX_MESSAGES
    });

    await message.reply({
      content: `Reindicizzazione completata: ho cancellato ${result.deletedRows} vecchie righe, salvato ${result.totalMessages} messaggi e trovato ${result.totalAttachments} allegati su Supabase (${result.storage}).`,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    logError('archive:reindex', 'Errore durante la reindicizzazione del canale:', error);

    try {
      await message.reply({
        content: buildIndexErrorMessage(error),
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      logError('archive:reindex', "Errore durante l'invio del messaggio di errore della reindicizzazione:", replyError);
    }
  }
}


function getArchiveSearchQuery(message) {
  const content = (message.content ?? '').trim();
  const normalized = content.toLowerCase();

  if (normalized.startsWith(ARCHIVE_VERIFY_COMMAND_PREFIX)) {
    return content.slice(ARCHIVE_VERIFY_COMMAND_PREFIX.length).trim();
  }

  return content.slice(ARCHIVE_SEARCH_COMMAND_PREFIX.length).trim();
}

async function handleArchiveSearchCommand(message) {
  const query = getArchiveSearchQuery(message);

  if (!query) {
    await message.reply({
      content: 'Scrivi cosa cercare dopo il comando. Esempio: `Jarvis cerca archivio viola`.',
      allowedMentions: { repliedUser: false }
    });
    return;
  }

  try {
    const search = await searchArchive(query);

    if (search.archiveEmpty) {
      await message.reply({
        content: 'Archivio vuoto. Prima indicizza almeno un canale.',
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    if (search.results.length === 0) {
      await message.reply({
        content: 'Non ho trovato risultati nell\'archivio.',
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    await replyWithChunks(message, formatArchiveResultsForDiscord(search.results));
  } catch (error) {
    logError('archive:search', "Errore durante la ricerca nell'archivio:", error);
    await message.reply({
      content: buildSupabaseConfigErrorMessage(error) ?? "Errore durante la ricerca nell'archivio Supabase. Controlla i log del bot.",
      allowedMentions: { repliedUser: false }
    });
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

function normalizeForRules(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getCustomReply(prompt) {
  const normalized = normalizeForRules(prompt);

  if (
    normalized.includes('chi ti ha creato')
    || normalized.includes('chi e il tuo creatore')
    || normalized.includes('da chi sei stato creato')
  ) {
    return 'Mi ha creato Mike, detto anche Majic. Il mio boss.';
  }

  const lightRoastPatterns = [
    /va a cagar/,
    /vaffanculo/,
    /vattene/,
    /sei scemo/
  ];

  if (lightRoastPatterns.some((pattern) => pattern.test(normalized))) {
    const replies = [
      'Ok, vado in bagno e dirò: la stronzata.',
      'Ricevuto, mi metto in modalità bagno operativo.',
      'Va bene, attivo la modalità permaloso livello tostapane.',
      'Capito capo, faccio un giro e torno più brillante di prima.',
      'Messaggio ricevuto: mi parcheggio un attimo in modalità zen.'
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  return null;
}

function shouldUseArchive(prompt) {
  const normalized = normalizeForRules(prompt);
  const archiveTerms = [
    'procedura',
    'storico',
    'intervento',
    'numero',
    'telefono',
    'guasto',
    'modem',
    'seriale',
    'fibra',
    'colori',
    'splitter',
    'delivery',
    'tim',
    'fastweb',
    'vodafone',
    'wind',
    'iliad',
    'sky',
    'open fiber',
    'causa',
    'causale',
    'a24',
    'a14',
    'permuta',
    'ont',
    'onu',
    'armadio',
    'centrale',
    'app',
    'tecnico',
    'materiale',
    'magazzino'
  ];

  return archiveTerms.some((term) => {
    if (term.includes(' ')) return normalized.includes(term);
    return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, 'i').test(normalized);
  });
}

function isClearlyTechnicalArchiveQuestion(prompt) {
  const normalized = normalizeForRules(prompt);
  const strongTerms = [
    'procedura',
    'storico',
    'intervento',
    'guasto',
    'modem',
    'seriale',
    'fibra',
    'colori',
    'splitter',
    'delivery',
    'tim',
    'fastweb',
    'vodafone',
    'wind',
    'iliad',
    'sky',
    'open fiber',
    'causale',
    'a24',
    'a14',
    'permuta',
    'ont',
    'onu',
    'armadio',
    'centrale',
    'tecnico',
    'materiale',
    'magazzino'
  ];

  if (strongTerms.some((term) => normalized.includes(term))) return true;

  return /\b(numero|telefono)\b/.test(normalized) && /\d{2,}/.test(normalized);
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

async function buildPromptWithArchiveContext(prompt) {
  if (!shouldUseArchive(prompt)) {
    return { prompt, usedArchive: false, archiveHadResults: false };
  }

  try {
    const search = await searchArchive(prompt);

    if (search.archiveEmpty || search.results.length === 0) {
      return {
        prompt,
        usedArchive: true,
        archiveHadResults: false,
        shouldReportMissingArchiveAnswer: isClearlyTechnicalArchiveQuestion(prompt)
      };
    }

    const context = formatArchiveResultsForGemini(search.results);
    return {
      usedArchive: true,
      archiveHadResults: true,
      shouldReportMissingArchiveAnswer: false,
      prompt: `DOMANDA UTENTE:
${prompt}

CONTENUTO ARCHIVIO DISCORD
${context}

ISTRUZIONI:
- Usa SOLO il CONTENUTO ARCHIVIO DISCORD per rispondere se è pertinente alla domanda.
- Se il contenuto archivio contiene la risposta, rispondi in modo diretto usando quei dati.
- Se la domanda riguarda dati aziendali, procedure, numerazioni o storico e il contenuto archivio non contiene la risposta, di' che non trovi la risposta nell'archivio.
- Non usare conoscenza generale se contraddice o sostituisce l'archivio.`
    };
  } catch (error) {
    logError('archive:search', "Errore durante la ricerca del contesto nell'archivio:", error);
    return { prompt, usedArchive: false, archiveHadResults: false };
  }
}

async function askGemini(channelId, prompt) {
  const history = getChannelHistory(channelId);
  const archivePrompt = await buildPromptWithArchiveContext(prompt);

  if (archivePrompt.shouldReportMissingArchiveAnswer) {
    return 'Non ho trovato questa informazione nell\'archivio.';
  }

  try {
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: convertHistoryToGeminiContents(history, archivePrompt.prompt),
      config: {
        systemInstruction:
          `Sei Jarvis, un assistente AI dentro Discord. Rispondi sempre in italiano, in modo chiaro, pratico, naturale e simpatico. Per messaggi normali conversa liberamente senza citare l'archivio. Se è presente un blocco CONTENUTO ARCHIVIO DISCORD, devi dare priorità assoluta a quello. Non usare conoscenza generale se contraddice l'archivio. Se la domanda riguarda dati aziendali, procedure, numerazioni o storico e l'archivio ha risultati, rispondi solo con i dati trovati. Se il contesto non contiene la risposta, di' chiaramente che non trovi la risposta nell'archivio.`,
        temperature: 0.4
      }
    });

    return response.text?.trim() || 'Mi dispiace, non sono riuscito a generare una risposta.';
  } catch (error) {
    if (isGeminiQuotaOrApiKeyError(error)) {
      logError('gemini', 'Errore Gemini API key/quota:', error);
    } else {
      logError('gemini', 'Errore durante la chiamata a Gemini:', error);
    }

    throw error;
  }
}

function startDiscordDiagnostics() {
  setInterval(() => {
    logInfo(
      'discord:heartbeat',
      `client.ws.status=${client.ws.status} ping=${client.ws.ping} user=${client.user?.tag ?? 'non disponibile'}`
    );
  }, DISCORD_DIAGNOSTICS_INTERVAL_MS);
}

client.once(Events.ClientReady, (readyClient) => {
  logInfo('discord:ready', `Jarvis è online come ${readyClient.user.tag}`);
  startDiscordDiagnostics();
});

client.on('error', (error) => {
  logError('discord:error', 'Errore client Discord:', error);
});

client.on('warn', (warning) => {
  logWarn('discord:warn', 'Avviso client Discord:', warning);
});

client.on('shardDisconnect', (closeEvent, shardId) => {
  logWarn(
    'discord:shardDisconnect',
    `Shard ${shardId} disconnesso. code=${closeEvent?.code ?? 'n/a'} reason=${closeEvent?.reason ?? 'n/a'}`
  );
});

client.on('shardReconnecting', (shardId) => {
  logWarn('discord:shardReconnecting', `Shard ${shardId} in riconnessione...`);
});

client.on('shardResume', (shardId, replayedEvents) => {
  logInfo('discord:shardResume', `Shard ${shardId} ripristinato. eventi riprodotti=${replayedEvents}`);
});

client.on('shardError', (error, shardId) => {
  logError('discord:shardError', `Errore shard ${shardId}:`, error);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignora messaggi di altri bot per evitare loop o risposte indesiderate.
  if (message.author.bot) return;

  if (isArchiveCommand(message)) {
    await handleArchiveCommand(message);
    return;
  }

  if (isArchiveSearchCommand(message)) {
    await handleArchiveSearchCommand(message);
    return;
  }

  if (!shouldReply(message)) return;

  const prompt = cleanUserPrompt(message);

  try {
    await message.channel.sendTyping();

    const customReply = getCustomReply(prompt);
    const reply = customReply ?? await askGemini(message.channel.id, prompt);

    rememberMessage(message.channel.id, 'user', prompt);
    rememberMessage(message.channel.id, 'assistant', reply);

    for (const chunk of splitDiscordMessage(reply)) {
      await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  } catch (error) {
    logError('discord:message', 'Errore durante la gestione del messaggio:', error);

    try {
      await message.reply({
        content: 'Mi dispiace, si è verificato un errore mentre elaboravo la richiesta. Riprova tra poco.',
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      logError('discord:message', 'Errore durante l\'invio del messaggio di errore:', replyError);
    }
  }
});

startHealthServer();

client.login(DISCORD_TOKEN).catch((error) => {
  logError('discord:login', 'Errore durante il login del bot Discord:', error);
  process.exit(1);
});
