import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
  prepareArchiveResultsForQuestion,
  searchArchive
} from './src/archiveSearch.js';
import {
  WebSearchConfigError,
  formatWebResultsForGemini,
  searchWeb,
  shouldUseWebSearch
} from './src/tools/webSearch.js';
import { formatRoutePlanForDiscord, planFreeOptimizedRoute } from './src/tools/freeRoutePlanner.js';

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

const {
  DISCORD_TOKEN,
  AI_PROVIDER = 'gemini',
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.5-flash',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4.1-mini'
} = process.env;
const ACTIVE_AI_PROVIDER = AI_PROVIDER.trim().toLowerCase();

if (!DISCORD_TOKEN) {
  logError('config', 'Errore: DISCORD_TOKEN non è configurato nel file .env');
  process.exit(1);
}

if (!['gemini', 'openai'].includes(ACTIVE_AI_PROVIDER)) {
  logError('config', "Errore: AI_PROVIDER deve essere 'gemini' oppure 'openai' nel file .env");
  process.exit(1);
}

if (ACTIVE_AI_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
  logError('config', 'Errore: GEMINI_API_KEY non è configurato nel file .env');
  process.exit(1);
}

if (ACTIVE_AI_PROVIDER === 'openai' && !OPENAI_API_KEY) {
  logError('config', 'Errore: OPENAI_API_KEY non è configurato nel file .env');
  process.exit(1);
}

const gemini = ACTIVE_AI_PROVIDER === 'gemini' ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

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
const MAX_MEMORY_MESSAGES = 20;
const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024;
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
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
const RAW_PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const PORT = Number.isFinite(RAW_PORT) && RAW_PORT > 0 ? RAW_PORT : 3000;
const DISCORD_DIAGNOSTICS_INTERVAL_MS = 60_000;
const DISCORD_RELOGIN_DELAY_MS = 5_000;
let diagnosticsStarted = false;
let reloginInProgress = false;
const routeMapPages = new Map();
const ROUTE_MAP_PAGE_TTL_MS = 60 * 60 * 1000;

const CHATGPT_LIKE_SYSTEM_INSTRUCTION = `Sei Jarvis, un assistente AI dentro Discord con uno stile conversazionale simile a ChatGPT.
Obiettivo principale: essere utile, accurato, naturale e collaborativo.
Linee guida generali:
- Rispondi sempre in italiano, salvo richiesta esplicita di un'altra lingua.
- Adatta tono, lunghezza e livello tecnico alla domanda dell'utente.
- Se la richiesta è semplice, rispondi direttamente; se è complessa, struttura la risposta con punti o passaggi chiari.
- Se mancano informazioni importanti, fai una domanda di chiarimento breve oppure dichiara l'assunzione che stai facendo.
- Non inventare dettagli: segnala incertezza, limiti o dati mancanti quando serve.
- Per codice, procedure e troubleshooting, dai istruzioni pratiche, esempi e prossimi passi verificabili.
- Mantieni un tono amichevole e naturale, senza essere invadente o eccessivamente scherzoso.
- Non citare l'archivio o il web nei messaggi normali se non sono stati forniti blocchi di contesto.
Regole sul contesto:
- Se è presente un blocco CONTENUTO ARCHIVIO DISCORD, dagli priorità assoluta rispetto alla conoscenza generale.
- Non usare conoscenza generale se contraddice l'archivio.
- Se la domanda riguarda dati aziendali, procedure, numerazioni o storico e l'archivio ha risultati, rispondi solo con i dati trovati.
- Se il contesto archivio non contiene la risposta, di' chiaramente che non trovi la risposta nell'archivio.
- Se è presente un blocco CONTENUTO WEB AGGIORNATO, usalo per dati recenti e includi una fonte/link principale quando disponibile.
- Non inventare dati aggiornati senza fonti web.
- Se i risultati web non sono sufficienti o sono ambigui, avvisa chiaramente.`;



function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildPublicUrl(path) {
  const baseUrl = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  return `${baseUrl}${path}`;
}

function buildRouteMapHtml(plan) {
  const stopsJson = JSON.stringify(plan.orderedStops.map((stop, index) => ({
    number: index + 1,
    address: `${stop.address}${stop.area ? `, ${stop.area}` : ''}`,
    lat: stop.lat,
    lon: stop.lon,
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.query)}`
  })));

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jarvis - percorso ottimizzato</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; }
    header { padding: 14px 16px; border-bottom: 1px solid #e5e7eb; }
    h1 { font-size: 18px; margin: 0 0 6px; }
    p { margin: 0; }
    #map { height: 72vh; min-height: 420px; }
    .summary { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
    .pill { background: #eef2ff; border-radius: 999px; padding: 6px 10px; }
    .marker-label { background: #2563eb; color: white; border-radius: 999px; width: 28px; height: 28px; display: grid; place-items: center; font-weight: 700; border: 2px solid white; box-shadow: 0 1px 4px #0006; }
    ol { margin: 12px 16px 24px; padding-left: 24px; }
    li { margin-bottom: 8px; }
  </style>
</head>
<body>
  <header>
    <h1>Percorso ottimizzato da Jarvis</h1>
    <div class="summary">
      <span class="pill">Distanza: ${escapeHtml(plan.distanceText)}</span>
      <span class="pill">Tempo stimato: ${escapeHtml(plan.durationText)}</span>
      <a class="pill" href="${escapeHtml(plan.googleMapsUrl)}" target="_blank" rel="noreferrer">Apri percorso in Google Maps</a>
    </div>
  </header>
  <div id="map"></div>
  <ol id="stops"></ol>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const stops = ${stopsJson};
    const map = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    const latLngs = stops.map((stop) => [stop.lat, stop.lon]);
    stops.forEach((stop) => {
      const icon = L.divIcon({ className: '', html: '<div class="marker-label">' + stop.number + '</div>', iconSize: [32, 32], iconAnchor: [16, 16] });
      L.marker([stop.lat, stop.lon], { icon })
        .addTo(map)
        .bindPopup('<strong>' + stop.number + '. ' + stop.address + '</strong><br><a target="_blank" rel="noreferrer" href="' + stop.mapsUrl + '">Apri in Google Maps</a>');
    });
    L.polyline(latLngs, { color: '#2563eb', weight: 5, opacity: 0.8 }).addTo(map);
    map.fitBounds(latLngs, { padding: [40, 40] });
    document.getElementById('stops').innerHTML = stops.map((stop) => '<li><a target="_blank" rel="noreferrer" href="' + stop.mapsUrl + '">' + stop.address + '</a></li>').join('');
  </script>
</body>
</html>`;
}

function createRouteMapPage(plan) {
  const id = randomUUID();
  routeMapPages.set(id, {
    html: buildRouteMapHtml(plan),
    expiresAt: Date.now() + ROUTE_MAP_PAGE_TTL_MS
  });
  return buildPublicUrl(`/maps/${id}`);
}

function cleanupExpiredRouteMapPages() {
  const now = Date.now();
  for (const [id, page] of routeMapPages.entries()) {
    if (page.expiresAt <= now) routeMapPages.delete(id);
  }
}

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

    if (path.startsWith('/maps/')) {
      cleanupExpiredRouteMapPages();
      const id = path.slice('/maps/'.length);
      const page = routeMapPages.get(id);

      if (page) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page.html);
        return;
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Map not found or expired');
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

    const focusedResults = prepareArchiveResultsForQuestion(query, search.results);
    await replyWithChunks(message, formatArchiveResultsForDiscord(focusedResults));
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

function isDirectBotMention(message) {
  return Boolean(client.user && message.mentions.users.has(client.user.id));
}

function startsWithJarvis(message) {
  return /^jarvis(?:\b|[\s:,.!?])/i.test((message.content ?? '').trim());
}

function isAddressedToJarvis(message) {
  return isDirectBotMention(message) || startsWithJarvis(message);
}

function hasGenericMention(message) {
  return message.mentions.roles.size > 0 || message.mentions.channels.size > 0;
}

function shouldSkipBeforeHandling(message) {
  if (message.mentions.everyone || /(^|\s)@(everyone|here)\b/i.test(message.content ?? '')) {
    logInfo('skip', 'everyone/here mention ignored');
    return true;
  }

  if (!isAddressedToJarvis(message)) {
    if (hasGenericMention(message) || /\bjarvis\b/i.test(message.content ?? '')) {
      logInfo('skip', 'not addressed to Jarvis');
    }
    return true;
  }

  return false;
}

function shouldReply(message) {
  return isAddressedToJarvis(message);
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


function isRoutePlanningPrompt(prompt) {
  const normalized = normalizeForRules(prompt);
  return /(calcol|crea|fammi|genera|ottimizz|miglior).{0,40}(percorso|giro|tragitto|mappa|strada|itinerario)/i.test(normalized)
    || /(percorso|giro|tragitto|mappa|strada|itinerario).{0,40}(miglior|ottim|veloce|breve)/i.test(normalized);
}

function getImageAttachment(message) {
  return [...message.attachments.values()].find((attachment) => {
    const contentType = attachment.contentType ?? '';
    return contentType.startsWith('image/') && attachment.url && attachment.size <= MAX_IMAGE_ATTACHMENT_BYTES;
  });
}

async function getRouteImageAttachment(message) {
  const directAttachment = getImageAttachment(message);
  if (directAttachment) return directAttachment;

  if (!message.reference?.messageId || typeof message.fetchReference !== 'function') {
    return null;
  }

  try {
    const referencedMessage = await message.fetchReference();
    return getImageAttachment(referencedMessage) ?? null;
  } catch (error) {
    logWarn('route:image', `Non riesco a leggere il messaggio citato ${message.reference.messageId}: ${error?.message ?? error}`);
    return null;
  }
}

async function downloadAttachmentAsBase64(attachment) {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Download allegato fallito: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

function stripJsonFence(text) {
  return String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function parseAddressExtractionJson(text) {
  const parsed = JSON.parse(stripJsonFence(text));
  const addresses = Array.isArray(parsed) ? parsed : parsed.addresses;

  if (!Array.isArray(addresses)) return [];

  return addresses
    .map((item, index) => ({
      label: String(item.label ?? index + 1),
      area: String(item.area ?? item.zona ?? item.locality ?? '').trim(),
      address: String(item.address ?? item.indirizzo ?? item.street ?? item.text ?? '').trim()
    }))
    .filter((item) => item.address);
}

function buildVisionAddressPrompt(userPrompt) {
  return `Leggi lo screenshot allegato e trova solo indirizzi, vie, civici e località utili per creare un percorso in auto.
Rispondi SOLO con JSON valido, senza markdown, nel formato:
{"addresses":[{"label":"1","area":"Comune o zona","address":"Via e civico"}]}
Se non trovi indirizzi, rispondi con {"addresses":[]}.
Richiesta utente: ${userPrompt}`;
}

async function extractAddressesFromImageWithGemini(attachment, prompt) {
  const base64Image = await downloadAttachmentAsBase64(attachment);
  const response = await generateGeminiContentWithRetry({
    model: GEMINI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: buildVisionAddressPrompt(prompt) },
        { inlineData: { mimeType: attachment.contentType, data: base64Image } }
      ]
    }],
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

  return parseAddressExtractionJson(response.text ?? '');
}

async function extractAddressesFromImageWithOpenAi(attachment, prompt) {
  const base64Image = await downloadAttachmentAsBase64(attachment);
  const response = await generateOpenAiResponseWithRetry({
    model: OPENAI_MODEL,
    instructions: 'Estrai indirizzi da screenshot e rispondi solo con JSON valido.',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: buildVisionAddressPrompt(prompt) },
        { type: 'input_image', image_url: `data:${attachment.contentType};base64,${base64Image}` }
      ]
    }],
    temperature: 0.1
  });

  return parseAddressExtractionJson(extractOpenAiText(response));
}

async function extractAddressesFromImage(attachment, prompt) {
  if (ACTIVE_AI_PROVIDER === 'openai') {
    return extractAddressesFromImageWithOpenAi(attachment, prompt);
  }

  return extractAddressesFromImageWithGemini(attachment, prompt);
}

function buildTextAddressPrompt(text) {
  return `Estrai da questa conversazione solo gli indirizzi/tappe utili per calcolare un percorso in auto.
Se una frase indica il punto di partenza, imposta "isStart": true per quella tappa.
Rispondi SOLO con JSON valido, senza markdown, nel formato:
{"addresses":[{"label":"1","area":"Comune o zona","address":"Via e civico o luogo","isStart":false}]}
Se non trovi almeno due tappe, rispondi con {"addresses":[]}.
TESTO:
${text}`;
}

function parseTextRouteExtractionJson(text) {
  const parsed = JSON.parse(stripJsonFence(text));
  const addresses = Array.isArray(parsed) ? parsed : parsed.addresses;

  if (!Array.isArray(addresses)) return [];

  return addresses
    .map((item, index) => ({
      label: String(item.label ?? index + 1),
      area: String(item.area ?? item.zona ?? item.locality ?? '').trim(),
      address: String(item.address ?? item.indirizzo ?? item.street ?? item.text ?? '').trim(),
      isStart: Boolean(item.isStart ?? item.start ?? item.is_start)
    }))
    .filter((item) => item.address);
}

async function extractAddressesFromTextWithGemini(text) {
  const response = await generateGeminiContentWithRetry({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: buildTextAddressPrompt(text) }] }],
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  });

  return parseTextRouteExtractionJson(response.text ?? '');
}

async function extractAddressesFromTextWithOpenAi(text) {
  const response = await generateOpenAiResponseWithRetry({
    model: OPENAI_MODEL,
    instructions: 'Estrai tappe/indirizzi da testo per un percorso e rispondi solo con JSON valido.',
    input: [{ role: 'user', content: buildTextAddressPrompt(text) }],
    temperature: 0.1
  });

  return parseTextRouteExtractionJson(extractOpenAiText(response));
}

async function extractAddressesFromText(text) {
  if (ACTIVE_AI_PROVIDER === 'openai') {
    return extractAddressesFromTextWithOpenAi(text);
  }

  return extractAddressesFromTextWithGemini(text);
}

function isRoutePlanningTextPrompt(channelId, prompt) {
  if (isRoutePlanningPrompt(prompt)) return true;

  const normalized = normalizeForRules(prompt);
  if (/\b(parto da|partenza|partire da|indirizzi|tappe|vie|mappa|maps)\b/i.test(normalized)) {
    return true;
  }

  const recentRouteContext = getChannelHistory(channelId)
    .slice(-4)
    .some((message) => /\b(percorso|mappa|tragitto|tappe|indirizzi|partenza)\b/i.test(normalizeForRules(message.content)));

  return recentRouteContext && /\b(parto|partenza|via|viale|piazza|corso|strada|centro|civico)\b/i.test(normalized);
}

function buildRecentRouteText(channelId, prompt) {
  const historyText = getChannelHistory(channelId)
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');

  return `${historyText}\nuser: ${prompt}`.trim();
}

async function maybeHandleRoutePlanningFromText(channelId, prompt) {
  if (!isRoutePlanningTextPrompt(channelId, prompt)) return null;

  try {
    const addresses = await extractAddressesFromText(buildRecentRouteText(channelId, prompt));
    if (addresses.length < 2) return null;

    const plan = await planFreeOptimizedRoute(addresses, { defaultArea: 'Lazio' });
    const mapUrl = plan.ok ? createRouteMapPage(plan) : null;
    return mapUrl ? `${formatRoutePlanForDiscord(plan)}\nMappa interattiva: ${mapUrl}` : formatRoutePlanForDiscord(plan);
  } catch (error) {
    logErrorWithStack('route:text', 'Errore durante calcolo percorso da testo:', error);
    return null;
  }
}

async function maybeHandleRoutePlanningFromImage(message, prompt) {
  if (!isRoutePlanningPrompt(prompt)) return null;

  const imageAttachment = await getRouteImageAttachment(message);
  if (!imageAttachment) return null;

  try {
    const addresses = await extractAddressesFromImage(imageAttachment, prompt);
    if (addresses.length < 2) {
      return 'Ho provato a leggere lo screenshot, ma non ho trovato almeno due indirizzi chiari. Rimandamelo più grande oppure scrivimi le vie in testo.';
    }

    const plan = await planFreeOptimizedRoute(addresses, { defaultArea: 'Lazio' });
    const mapUrl = plan.ok ? createRouteMapPage(plan) : null;
    return mapUrl ? `${formatRoutePlanForDiscord(plan)}\nMappa interattiva: ${mapUrl}` : formatRoutePlanForDiscord(plan);
  } catch (error) {
    logErrorWithStack('route:image', 'Errore durante calcolo percorso da screenshot:', error);
    return 'Ho visto lo screenshot, ma non sono riuscito a leggere gli indirizzi o calcolare il percorso gratuito. Prova a rimandare l’immagine più nitida oppure scrivi le vie in testo.';
  }
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
    'riparato',
    'riparazione',
    'risolto',
    'ripristinato',
    'naviga',
    'rl',
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
    'riparato',
    'riparazione',
    'risolto',
    'ripristinato',
    'naviga',
    'rl',
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

function convertHistoryToOpenAiInput(history, prompt) {
  return [
    ...history.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content
    })),
    {
      role: 'user',
      content: prompt
    }
  ];
}

function isOpenAiRetryableError(error) {
  return error?.status === 429 || error?.status >= 500;
}

function isOpenAiConfigOrQuotaError(error) {
  return [401, 403, 429].includes(error?.status)
    || `${error?.message ?? ''}`.toLowerCase().includes('quota')
    || `${error?.message ?? ''}`.toLowerCase().includes('rate limit');
}

function extractOpenAiText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const textParts = data?.output
    ?.flatMap((item) => item?.content ?? [])
    ?.filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
    ?.map((content) => content.text.trim())
    ?.filter(Boolean) ?? [];

  return textParts.join('\n').trim();
}

async function generateOpenAiResponseWithRetry(request) {
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request)
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const error = new Error(data?.error?.message ?? `OpenAI API error ${response.status}`);
        error.status = response.status;
        error.code = data?.error?.code;
        throw error;
      }

      return data;
    } catch (error) {
      lastError = error;

      if (!isOpenAiRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = 1500 * attempt;
      logWarn('ai:retry', `OpenAI temporaneamente non disponibile, ritento tra ${delayMs} ms (tentativo ${attempt + 1}/${maxAttempts})...`);
      await wait(delayMs);
    }
  }

  throw lastError;
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


function getLocalFallbackReply(prompt, error) {
  const normalized = normalizeForRules(prompt);

  if (!(isGeminiOverloadedError(error) || isGeminiQuotaExceededError(error))) {
    return null;
  }

  if (normalized.includes('dimmi qualcosa di intelligente')) {
    return 'Te ne dico una intelligente anche senza Gemini: se una cosa si rompe spesso, non serve solo ripararla meglio; serve capire perché continua a rompersi. È lì che inizi a risparmiare tempo davvero.';
  }

  if (normalized.includes('dimmi qualcosa di bello')) {
    return 'Qualcosa di bello: anche nelle giornate storte, se riesci a far sorridere qualcuno hai già sistemato un pezzetto del mondo. Piccolo, ma reale.';
  }

  if (normalized.includes('come sei utile') || normalized.includes('sei utile')) {
    return 'Sono utile quando mi dai contesto: posso cercare nello storico indicizzato, riassumere procedure, aiutarti a scrivere risposte e controllare info online. Se Gemini fa i capricci, io resto comunque operativo sulle funzioni base.';
  }

  if (normalized.includes('nico') && (normalized.includes('prendere per culo') || normalized.includes('pippetta'))) {
    return 'Risposta elegante per Nico: “Tranquillo, la parte tecnica la sai. Per quella amministrativa facciamo come gli aggiornamenti: prima o poi arriva anche a te.” 😄';
  }

  if (normalized.includes('collega') && (normalized.includes('prendere per culo') || normalized.includes('pippetta'))) {
    return 'Gliela direi leggera: “Sei un tecnico in modalità beta: funzioni, ma ogni tanto serve una patch amministrativa.” 😄';
  }

  return 'Gemini ora è pieno o in quota, ma io non mollo: posso comunque aiutarti con archivio (`Jarvis archivio <testo>`), comandi, risposte brevi e ricerche online se Tavily è configurato.';
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

    const focusedResults = prepareArchiveResultsForQuestion(prompt, search.results);
    const context = formatArchiveResultsForGemini(focusedResults);
    return {
      usedArchive: true,
      archiveHadResults: true,
      shouldReportMissingArchiveAnswer: false,
      archiveSearchAttempted: true,
      archiveFallbackReply: formatArchiveResultsForDiscord(focusedResults),
      prompt: `DOMANDA UTENTE:
${prompt}

CONTENUTO ARCHIVIO DISCORD
${context}

ISTRUZIONI:
- Usa SOLO il CONTENUTO ARCHIVIO DISCORD per rispondere se è pertinente alla domanda.
- Il contenuto archivio è già stato tagliato sulla sezione più rilevante: non aggiungere procedure, COD o parti non presenti nel blocco.
- Se trovi COD, causale o procedura, rispondi breve e pratico con solo codice, descrizione, note operative ed eventuale esempio di chiusura.
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

async function generateGeminiContentWithRetry(request) {
  const maxAttempts = 2;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await gemini.models.generateContent(request);
    } catch (error) {
      lastError = error;

      if (!isGeminiOverloadedError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = 1500 * attempt;
      logWarn('ai:retry', `Gemini sovraccarico, ritento tra ${delayMs} ms (tentativo ${attempt + 1}/${maxAttempts})...`);
      await wait(delayMs);
    }
  }

  throw lastError;
}

async function askAi(channelId, prompt) {
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
    if (ACTIVE_AI_PROVIDER === 'openai') {
      const response = await generateOpenAiResponseWithRetry({
        model: OPENAI_MODEL,
        instructions: CHATGPT_LIKE_SYSTEM_INSTRUCTION,
        input: convertHistoryToOpenAiInput(history, webPrompt.prompt),
        temperature: 0.7,
        top_p: 0.95
      });

      return extractOpenAiText(response) || 'Mi dispiace, non sono riuscito a generare una risposta.';
    }

    const response = await generateGeminiContentWithRetry({
      model: GEMINI_MODEL,
      contents: convertHistoryToGeminiContents(history, webPrompt.prompt),
      config: {
        systemInstruction: CHATGPT_LIKE_SYSTEM_INSTRUCTION,
        temperature: 0.7,
        topP: 0.95
      }
    });

    return response.text?.trim() || 'Mi dispiace, non sono riuscito a generare una risposta.';
  } catch (error) {
    if (ACTIVE_AI_PROVIDER === 'openai') {
      logErrorWithStack('ai:error', 'Errore durante la chiamata a OpenAI:', error);
    } else if (isGeminiQuotaOrApiKeyError(error)) {
      logErrorWithStack('ai:error', 'Errore Gemini API key/quota:', error);
    } else {
      logErrorWithStack('ai:error', 'Errore durante la chiamata a Gemini:', error);
    }

    if (archivePrompt.archiveHadResults && archivePrompt.archiveFallbackReply) {
      return `Ho trovato queste informazioni nell'archivio indicizzato, ma il provider AI non ha risposto. Ti riporto i risultati grezzi:

${archivePrompt.archiveFallbackReply}`;
    }

    if (webPrompt.webHadResults && webPrompt.webFallbackReply) {
      return `${webPrompt.webFallbackReply}

Fonte: risultati Tavily disponibili nei log/contesto.`;
    }

    if (ACTIVE_AI_PROVIDER === 'openai' && isOpenAiConfigOrQuotaError(error)) {
      return 'OpenAI non sta accettando la richiesta: controlla OPENAI_API_KEY, modello, credito/quota e permessi. Il bot Discord è online.';
    }

    const localFallbackReply = getLocalFallbackReply(prompt, error);
    if (localFallbackReply) return localFallbackReply;

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

  // Prima di qualsiasi chiamata a Supabase, provider AI o Tavily, rispondi solo se
  // Jarvis è stato chiamato direttamente o il messaggio inizia con "Jarvis".
  if (shouldSkipBeforeHandling(message)) return;

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
    const routeImageReply = customReply ? null : await maybeHandleRoutePlanningFromImage(message, prompt);
    const routeTextReply = customReply || routeImageReply ? null : await maybeHandleRoutePlanningFromText(message.channel.id, prompt);
    const reply = customReply ?? routeImageReply ?? routeTextReply ?? await askAi(message.channel.id, prompt);

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
