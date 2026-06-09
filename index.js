import 'dotenv/config';
import { createServer } from 'node:http';
import { GoogleGenAI } from '@google/genai';
import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits, Status } from 'discord.js';
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
import {
  WebSearchConfigError,
  formatWebResultsForGemini,
  searchWeb,
  shouldUseWebSearch
} from './src/tools/webSearch.js';

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
const ARCHIVE_SHORT_COMMAND_PREFIX = 'jarvis archivio';
const DEFAULT_INDEX_MAX_MESSAGES = 5000;
const INDEX_MAX_MESSAGES = Number.parseInt(process.env.INDEX_MAX_MESSAGES ?? `${DEFAULT_INDEX_MAX_MESSAGES}`, 10);
const SAFE_INDEX_MAX_MESSAGES = Number.isFinite(INDEX_MAX_MESSAGES) && INDEX_MAX_MESSAGES > 0
  ? INDEX_MAX_MESSAGES
  : DEFAULT_INDEX_MAX_MESSAGES;
const RAW_PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const PORT = Number.isFinite(RAW_PORT) && RAW_PORT > 0 ? RAW_PORT : 3000;
const DISCORD_DIAGNOSTICS_INTERVAL_MS = 60_000;
const DISCORD_RELOGIN_DELAY_MS = 5_000;
let diagnosticsStarted = false;
let reloginInProgress = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    || content === ARCHIVE_VERIFY_COMMAND_PREFIX
    || content.startsWith(`${ARCHIVE_SHORT_COMMAND_PREFIX} `)
    || content === ARCHIVE_SHORT_COMMAND_PREFIX;
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

  if (normalized.startsWith(ARCHIVE_SHORT_COMMAND_PREFIX)) {
    return content.slice(ARCHIVE_SHORT_COMMAND_PREFIX.length).trim();
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
    logErrorWithStack('archiveSearch:error', "Errore durante la ricerca nell'archivio:", error);
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


  if (
    normalized.includes('quali sono i tuoi comandi')
    || normalized.includes('che comandi hai')
    || normalized.includes('lista comandi')
    || normalized.includes('cosa puoi fare')
  ) {
    return [
      'Posso aiutarti così:',
      '- `Jarvis cerca archivio <testo>` oppure `Jarvis archivio <testo>`: cerco nello storico indicizzato Supabase.',
      '- `Jarvis stato archivio`: mostro i canali indicizzati (solo admin).',
      '- `Jarvis indicizza questo canale`: salvo lo storico del canale su Supabase (solo admin).',
      '- `Jarvis reindicizza questo canale`: cancello e rifaccio il canale corrente (solo admin).',
      '- Puoi chiedermi procedure interne tipo “tubazione ostruita come lo chiudo?” e prima cerco nell’archivio.',
      '- Puoi chiedermi dati online/meteo/prezzi e uso Tavily se configurato.'
    ].join('\n');
  }

  return null;
}

function shouldUseArchive(prompt) {
  const normalized = normalizeForRules(prompt);
  const archiveTerms = [
    'procedura',
    'storico',
    'intervento',
    'lavorazione',
    'ticket',
    'pratica',
    'remedy',
    'flower',
    'assurance',
    'tubazione',
    'ostruita',
    'ostruito',
    'chiusura',
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
    'olo',
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
    'ko',
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

  if (normalized.includes('come lo chiudo') || normalized.includes('come chiudo')) {
    return true;
  }

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
    'lavorazione',
    'ticket',
    'pratica',
    'remedy',
    'flower',
    'assurance',
    'tubazione',
    'ostruita',
    'ostruito',
    'chiusura',
    'guasto',
    'modem',
    'seriale',
    'fibra',
    'colori',
    'splitter',
    'delivery',
    'tim',
    'olo',
    'fastweb',
    'vodafone',
    'wind',
    'iliad',
    'sky',
    'open fiber',
    'causale',
    'a24',
    'a14',
    'ko',
    'permuta',
    'ont',
    'onu',
    'armadio',
    'centrale',
    'tecnico',
    'materiale',
    'magazzino'
  ];

  if (normalized.includes('come lo chiudo') || normalized.includes('come chiudo')) return true;

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

function isGeminiOverloadedError(error) {
  const message = `${error?.message ?? ''} ${error?.status ?? ''} ${error?.code ?? ''}`.toLowerCase();
  return message.includes('503')
    || message.includes('unavailable')
    || message.includes('high demand')
    || message.includes('overloaded')
    || message.includes('try again later');
}

function isGeminiQuotaExceededError(error) {
  const message = `${error?.message ?? ''} ${error?.status ?? ''} ${error?.code ?? ''}`.toLowerCase();
  return message.includes('429')
    || message.includes('quota')
    || message.includes('resource_exhausted')
    || message.includes('free_tier_requests')
    || message.includes('rate limit');
}

function buildGeminiUserErrorMessage(error) {
  if (isGeminiQuotaExceededError(error)) {
    return 'Gemini ha finito la quota o sta limitando le richieste. Il bot è online, ma devo aspettare il reset quota oppure serve aumentare/abilitare il piano Google AI. Se vuoi, posso comunque cercare nello storico con `Jarvis archivio <testo>`.';
  }

  if (isGeminiOverloadedError(error)) {
    return 'Gemini in questo momento è sovraccarico. Il bot è online: riprova tra poco. Per le procedure interne puoi usare subito `Jarvis archivio <testo>`.';
  }

  if (isGeminiQuotaOrApiKeyError(error)) {
    return 'Gemini non sta accettando la richiesta: controlla GEMINI_API_KEY, modello e permessi su Render/Google AI. Il bot Discord è online.';
  }

  return 'Ho avuto un problema temporaneo con Gemini. Il bot è online: riprova tra poco oppure usa `Jarvis archivio <testo>` per interrogare direttamente lo storico indicizzato.';
}

async function buildPromptWithArchiveContext(prompt) {
  if (!shouldUseArchive(prompt)) {
    return { prompt, usedArchive: false, archiveHadResults: false, archiveSearchAttempted: false };
  }

  try {
    const search = await searchArchive(prompt);

    if (search.archiveEmpty || search.results.length === 0) {
      return {
        prompt,
        usedArchive: true,
        archiveHadResults: false,
        shouldReportMissingArchiveAnswer: isClearlyTechnicalArchiveQuestion(prompt),
        archiveSearchAttempted: true
      };
    }

    const context = formatArchiveResultsForGemini(search.results);
    return {
      usedArchive: true,
      archiveHadResults: true,
      shouldReportMissingArchiveAnswer: false,
      archiveSearchAttempted: true,
      archiveFallbackReply: formatArchiveResultsForDiscord(search.results),
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
    logErrorWithStack('archiveSearch:error', "Errore durante la ricerca del contesto nell'archivio:", error);
    return {
      prompt,
      usedArchive: false,
      archiveHadResults: false,
      archiveSearchAttempted: true,
      archiveSearchError: true
    };
  }
}

async function buildPromptWithWebContext(prompt, originalPrompt, options = {}) {
  if (!options.force && !shouldUseWebSearch(originalPrompt)) {
    return { prompt, usedWeb: false };
  }

  try {
    const search = await searchWeb(originalPrompt, { maxResults: 5 });

    if (search.error) {
      return {
        prompt,
        usedWeb: true,
        webHadResults: false,
        webSearchFailed: true
      };
    }

    if (search.results.length === 0) {
      return {
        prompt: `DOMANDA UTENTE:
${originalPrompt}

RICERCA ONLINE:
Non sono stati trovati risultati sufficienti.

ISTRUZIONI:
- Rispondi in italiano in modo breve.
- Avvisa chiaramente che i risultati online non sono sufficienti.
- Non inventare dati aggiornati.`,
        usedWeb: true,
        webHadResults: false
      };
    }

    const context = formatWebResultsForGemini(search);
    return {
      usedWeb: true,
      webHadResults: true,
      webFallbackReply: search.responseText || formatWebResultsForGemini(search),
      prompt: `${prompt}

CONTENUTO WEB AGGIORNATO
Provider: ${search.provider}
Query: ${search.query}
${context}

ISTRUZIONI WEB:
- Usa il CONTENUTO WEB AGGIORNATO per rispondere a dati recenti, prezzi, meteo, notizie, eventi, aziende, prodotti, luoghi, orari o risultati sportivi.
- Non dire che non hai accesso a dati in tempo reale: se il blocco web è presente, usa quei risultati.
- Rispondi in italiano in modo breve e utile.
- Includi la fonte/link principale quando disponibile.
- Se i risultati non sono sufficienti o sono ambigui, dillo chiaramente.
- Non inventare dati aggiornati non presenti nelle fonti.`
    };
  } catch (error) {
    if (error instanceof WebSearchConfigError) {
      return {
        prompt,
        usedWeb: true,
        webHadResults: false,
        webConfigMissing: true
      };
    }

    logErrorWithStack('webSearch:error', 'Errore durante la ricerca online:', error);
    return {
      prompt: `DOMANDA UTENTE:
${originalPrompt}

RICERCA ONLINE:
La ricerca online ha generato un errore tecnico.

ISTRUZIONI:
- Rispondi in italiano in modo breve.
- Avvisa che non riesci a verificare online in questo momento.
- Non inventare dati aggiornati.`,
      usedWeb: true,
      webHadResults: false
    };
  }
}

async function askGemini(channelId, prompt) {
  const history = getChannelHistory(channelId);
  const archivePrompt = await buildPromptWithArchiveContext(prompt);
  const needsWebSearch = shouldUseWebSearch(prompt);
  const shouldFallbackToWeb = !archivePrompt.archiveHadResults
    && (needsWebSearch || archivePrompt.archiveSearchAttempted || archivePrompt.shouldReportMissingArchiveAnswer || archivePrompt.archiveSearchError);

  if (archivePrompt.shouldReportMissingArchiveAnswer && !shouldFallbackToWeb) {
    return "Non ho trovato questa informazione nell'archivio.";
  }

  const webPrompt = shouldFallbackToWeb
    ? await buildPromptWithWebContext(archivePrompt.prompt, prompt, { force: true })
    : { prompt: archivePrompt.prompt, usedWeb: false };

  if (webPrompt.webConfigMissing) {
    return 'La ricerca online non è ancora configurata. Serve impostare la chiave API su Render.';
  }

  if (webPrompt.webSearchFailed) {
    return 'Non riesco a fare la ricerca online in questo momento. Controlla TAVILY_API_KEY o i log Render.';
  }

  try {
    const response = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: convertHistoryToGeminiContents(history, webPrompt.prompt),
      config: {
        systemInstruction:
          `Sei Jarvis, un assistente AI dentro Discord. Rispondi sempre in italiano, in modo chiaro, pratico, naturale e simpatico. Per messaggi normali conversa liberamente senza citare l'archivio. Se è presente un blocco CONTENUTO ARCHIVIO DISCORD, devi dare priorità assoluta a quello. Non usare conoscenza generale se contraddice l'archivio. Se è presente un blocco CONTENUTO WEB AGGIORNATO, usalo per dati recenti e includi una fonte/link principale quando disponibile. Non inventare dati aggiornati senza fonti web. Se i risultati web non sono sufficienti, avvisa chiaramente. Se la domanda riguarda dati aziendali, procedure, numerazioni o storico e l'archivio ha risultati, rispondi solo con i dati trovati. Se il contesto non contiene la risposta, di' chiaramente che non trovi la risposta nell'archivio.`,
        temperature: 0.4
      }
    });

    return response.text?.trim() || 'Mi dispiace, non sono riuscito a generare una risposta.';
  } catch (error) {
    if (isGeminiQuotaOrApiKeyError(error)) {
      logErrorWithStack('ai:error', 'Errore Gemini API key/quota:', error);
    } else {
      logErrorWithStack('ai:error', 'Errore durante la chiamata a Gemini:', error);
    }

    if (archivePrompt.archiveHadResults && archivePrompt.archiveFallbackReply) {
      return `Ho trovato queste informazioni nell'archivio indicizzato, ma Gemini non ha risposto. Ti riporto i risultati grezzi:

${archivePrompt.archiveFallbackReply}`;
    }

    if (webPrompt.webHadResults && webPrompt.webFallbackReply) {
      return `${webPrompt.webFallbackReply}

Fonte: risultati Tavily disponibili nei log/contesto.`;
    }

    return buildGeminiUserErrorMessage(error);
  }
}

function getWebSocketStatusLabel(status) {
  return `${Status[status] ?? 'Unknown'} (${status})`;
}

function formatMemoryUsage() {
  const memory = process.memoryUsage();
  const toMb = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;

  return `rss=${toMb(memory.rss)} heapUsed=${toMb(memory.heapUsed)} heapTotal=${toMb(memory.heapTotal)} external=${toMb(memory.external)}`;
}

function formatProcessUptime() {
  return `${Math.round(process.uptime())}s`;
}

function logErrorWithStack(scope, message, error) {
  logError(scope, message, error?.stack ?? error);
}

async function reloginDiscord(reason) {
  if (reloginInProgress) {
    logWarn('discord:watchdog', `Relogin già in corso, salto nuovo tentativo. Motivo: ${reason}`);
    return;
  }

  reloginInProgress = true;

  try {
    logWarn('discord:watchdog', `Avvio relogin Discord. Motivo: ${reason}`);

    try {
      client.destroy();
      logWarn('discord:watchdog', 'client.destroy() completato prima del relogin.');
    } catch (destroyError) {
      logErrorWithStack('discord:watchdog', 'Errore durante client.destroy() prima del relogin:', destroyError);
    }

    await wait(DISCORD_RELOGIN_DELAY_MS);
    await client.login(DISCORD_TOKEN);
    logInfo('discord:watchdog', 'Relogin Discord completato.');
  } catch (loginError) {
    logErrorWithStack('discord:watchdog', 'Relogin Discord fallito:', loginError);
  } finally {
    reloginInProgress = false;
  }
}

function logDiscordHeartbeat() {
  logInfo(
    'discord:heartbeat',
    `status=${getWebSocketStatusLabel(client.ws.status)} ping=${client.ws.ping} user=${client.user?.tag ?? 'non disponibile'} uptime=${formatProcessUptime()} memory=${formatMemoryUsage()}`
  );
}

async function runDiscordWatchdog() {
  const status = client.ws.status;
  const userMissing = client.user === null;

  if (status === Status.Ready && !userMissing) return;

  logWarn(
    'discord:watchdog',
    `Stato Discord non sano: status=${getWebSocketStatusLabel(status)} user=${client.user?.tag ?? 'null'} ping=${client.ws.ping}. Provo relogin...`
  );

  await reloginDiscord(`status=${getWebSocketStatusLabel(status)} userMissing=${userMissing}`);
}

function startDiscordDiagnostics() {
  if (diagnosticsStarted) return;
  diagnosticsStarted = true;

  setInterval(() => {
    try {
      logDiscordHeartbeat();
    } catch (error) {
      logErrorWithStack('discord:heartbeat', 'Errore nel heartbeat applicativo:', error);
    }
  }, DISCORD_DIAGNOSTICS_INTERVAL_MS);

  setInterval(() => {
    runDiscordWatchdog().catch((error) => {
      logErrorWithStack('discord:watchdog', 'Errore non gestito nel watchdog Discord:', error);
    });
  }, DISCORD_DIAGNOSTICS_INTERVAL_MS);
}

process.on('unhandledRejection', (reason) => {
  logErrorWithStack('process:unhandledRejection', 'Promise rejection non gestita:', reason);
});

process.on('uncaughtException', (error) => {
  logErrorWithStack('process:uncaughtException', 'Eccezione non gestita:', error);
});

client.on(Events.ClientReady, (readyClient) => {
  logInfo('discord:ready', `Jarvis è online come ${readyClient.user.tag}`);
});

client.on(Events.Error, (error) => {
  logErrorWithStack('discord:error', 'Errore client Discord:', error);
});

client.on(Events.Warn, (warning) => {
  logWarn('discord:warn', 'Avviso client Discord:', warning);
});

client.on(Events.Debug, (debugMessage) => {
  logInfo('discord:debug', debugMessage);
});

client.on(Events.Invalidated, () => {
  logWarn('discord:invalidated', 'Sessione Discord invalidata. Il watchdog tenterà il relogin se necessario.');
});

client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
  logWarn(
    'discord:shardDisconnect',
    `Shard ${shardId} disconnesso. code=${closeEvent?.code ?? 'n/a'} reason=${closeEvent?.reason ?? 'n/a'} wasClean=${closeEvent?.wasClean ?? 'n/a'}`
  );
});

client.on(Events.ShardReconnecting, (shardId) => {
  logWarn('discord:shardReconnecting', `Shard ${shardId} in riconnessione... status=${getWebSocketStatusLabel(client.ws.status)}`);
});

client.on(Events.ShardResume, (shardId, replayedEvents) => {
  logInfo('discord:shardResume', `Shard ${shardId} ripristinato. eventi riprodotti=${replayedEvents} status=${getWebSocketStatusLabel(client.ws.status)}`);
});

client.on(Events.ShardError, (error, shardId) => {
  logErrorWithStack('discord:shardError', `Errore shard ${shardId}:`, error);
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
    logErrorWithStack('ai:error', 'Errore durante la gestione del messaggio:', error);

    try {
      await message.reply({
        content: 'Mi dispiace, si è verificato un errore mentre elaboravo la richiesta. Riprova tra poco.',
        allowedMentions: { repliedUser: false }
      });
    } catch (replyError) {
      logErrorWithStack('ai:error', 'Errore durante l\'invio del messaggio di errore:', replyError);
    }
  }
});

startHealthServer();
startDiscordDiagnostics();

client.login(DISCORD_TOKEN).catch((error) => {
  logErrorWithStack('discord:login', 'Errore durante il login del bot Discord:', error);
  process.exit(1);
});
