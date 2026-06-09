import { getSupabaseClient } from './supabaseClient.js';

const SUPABASE_TABLE = 'discord_messages';
const MAX_RESULTS = 10;
const SUPABASE_SEARCH_LIMIT = 200;
const STOP_WORDS = new Set([
  'jarvis',
  'il',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'una',
  'che',
  'cosa',
  'come',
  'dove',
  'quando',
  'quanto',
  'quale',
  'quali',
  'lo',
  'mi',
  'devo',
  'posso',
  'fare',
  'della',
  'del',
  'di',
  'a',
  'e',
  'o'
]);
const ARCHIVE_DOMAIN_WORDS = new Set([
  'colori',
  'colore',
  'fibra',
  'numerazione',
  'numero',
  'rosso',
  'verde',
  'giallo',
  'blu',
  'bianco',
  'viola',
  'arancione',
  'nero',
  'grigio',
  'marrone',
  'rosa',
  'turchese'
]);
const TECHNICAL_SYNONYMS = {
  tubazione: ['tubazione', 'tubo', 'ostruita', 'ostruito', 'chiusura', 'chiudo', 'a24', 'a14'],
  tubo: ['tubazione', 'tubo', 'ostruita', 'ostruito', 'chiusura', 'a24', 'a14'],
  ostruita: ['tubazione', 'tubo', 'ostruita', 'ostruito', 'chiusura', 'a24', 'a14'],
  ostruito: ['tubazione', 'tubo', 'ostruita', 'ostruito', 'chiusura', 'a24', 'a14'],
  chiusura: ['chiusura', 'causale', 'a24', 'a14', 'dr', 'ko'],
  chiudo: ['chiusura', 'causale', 'a24', 'a14', 'dr', 'ko'],
  fibra: ['fibra', 'colori', 'numerazione', 'splitter', 'cavo'],
  colori: ['fibra', 'colori', 'numerazione', 'splitter', 'cavo'],
  modem: ['modem', 'seriale', 'scarico', 'guasto'],
  delivery: ['delivery', 'chiusura', 'causale', 'tim', 'olo'],
  permuta: ['permuta', 'centrale', 'armadio', 'onu', 'ont'],
  causale: ['causale', 'chiusura', 'a24', 'a14', 'dr', 'ko'],
  guasto: ['guasto', 'modem', 'seriale', 'causale', 'chiusura'],
  seriale: ['seriale', 'modem', 'scarico', 'guasto'],
  splitter: ['splitter', 'fibra', 'colori', 'numerazione'],
  tim: ['tim', 'delivery', 'olo', 'causale'],
  olo: ['olo', 'delivery', 'tim', 'causale'],
  fastweb: ['fastweb', 'delivery', 'olo', 'causale'],
  vodafone: ['vodafone', 'delivery', 'olo', 'causale'],
  wind: ['wind', 'delivery', 'olo', 'causale'],
  iliad: ['iliad', 'delivery', 'olo', 'causale'],
  sky: ['sky', 'delivery', 'olo', 'causale'],
  centrale: ['centrale', 'armadio', 'permuta', 'onu', 'ont'],
  armadio: ['armadio', 'centrale', 'permuta', 'onu', 'ont'],
  ont: ['ont', 'onu', 'permuta', 'centrale', 'armadio'],
  onu: ['onu', 'ont', 'permuta', 'centrale', 'armadio'],
  a24: ['a24', 'tubazione', 'ostruita', 'chiusura'],
  a14: ['a14', 'tubazione', 'ostruita', 'chiusura'],
  dr: ['dr', 'causale', 'chiusura'],
  ko: ['ko', 'causale', 'chiusura']
};

const COLOR_WORDS = [
  'rosso',
  'verde',
  'giallo',
  'blu',
  'bianco',
  'viola',
  'arancione',
  'nero',
  'grigio',
  'marrone',
  'rosa',
  'turchese'
];

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractWords(value) {
  // Include codici brevi e alfanumerici come A24, A14, DR e KO.
  return normalizeText(value).match(/[a-z0-9]+/g) ?? [];
}

function hasArchiveDomainWord(words) {
  return words.some((word) => ARCHIVE_DOMAIN_WORDS.has(word));
}

function expandDomainWords(words) {
  const expandedWords = [...words];

  for (const word of words) {
    if (TECHNICAL_SYNONYMS[word]) {
      expandedWords.push(...TECHNICAL_SYNONYMS[word]);
    }
  }

  if (hasArchiveDomainWord(words)) {
    // Se la domanda riguarda colori/fibra/numerazioni, cerchiamo anche i termini
    // tipici delle tabelle colori: spesso il messaggio indicizzato contiene solo
    // la lista completa e non tutte le parole della domanda dell'utente.
    expandedWords.push('colori', 'colore', 'fibra', 'numerazione', 'numero', ...COLOR_WORDS);
  }

  return expandedWords;
}

function extractUsefulWords(query) {
  const words = extractWords(query);
  const usefulWords = words.filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  return [...new Set(expandDomainWords(usefulWords))];
}

function pushUnique(values, value) {
  const normalized = normalizeText(value).trim();
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

export function buildArchiveSearchQueries(prompt) {
  const words = extractWords(prompt).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  const queries = [];

  for (const word of words) {
    pushUnique(queries, word);
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    pushUnique(queries, `${words[index]} ${words[index + 1]}`);
  }

  const expandedWords = expandDomainWords(words);
  for (const word of expandedWords) {
    pushUnique(queries, word);
  }

  if (words.some((word) => ['tubazione', 'tubo', 'ostruita', 'ostruito'].includes(word))) {
    pushUnique(queries, 'tubazione ostruita');
    pushUnique(queries, 'chiusura tubazione');
    pushUnique(queries, 'a24');
    pushUnique(queries, 'a14');
  }

  if (words.some((word) => ['causale', 'chiusura', 'chiudo'].includes(word))) {
    pushUnique(queries, 'causale chiusura');
    pushUnique(queries, 'a24');
    pushUnique(queries, 'a14');
    pushUnique(queries, 'dr');
    pushUnique(queries, 'ko');
  }

  return queries.slice(0, 30);
}

function containsNumberedMultilineList(content) {
  const numberedLines = String(content ?? '')
    .split('\n')
    .filter((line) => /^\s*\d+\s*[-.)]?\s+\S+/.test(line));

  return numberedLines.length >= 2;
}

function containsColorNumberedList(content) {
  const normalized = normalizeText(content);
  return COLOR_WORDS.some((color) => new RegExp(`(^|\\n)\\s*\\d+\\s*[-.)]?\\s+${color}\\b`, 'i').test(normalized));
}

function getMessageScore(message, usefulWords, originalWords, searchQueries = []) {
  const content = normalizeText(message.content);
  const matchedWords = usefulWords.filter((word) => content.includes(word));
  let score = matchedWords.length;

  for (const query of searchQueries) {
    const normalizedQuery = normalizeText(query);
    if (normalizedQuery.includes(' ') && content.includes(normalizedQuery)) {
      score += 5;
    }
  }

  if (score > 0 && containsNumberedMultilineList(message.content)) {
    score += 2;
  }

  if (hasArchiveDomainWord(originalWords) && containsColorNumberedList(message.content)) {
    score += 4;
  }

  // Se l'utente chiede un colore specifico e il messaggio contiene una riga
  // numerata con quel colore, questo risultato deve avere priorità alta.
  for (const color of COLOR_WORDS) {
    if (originalWords.includes(color) && new RegExp(`(^|\\n)\\s*\\d+\\s*[-.)]?\\s+${color}\\b`, 'i').test(content)) {
      score += 8;
    }
  }

  if (originalWords.some((word) => ['tubazione', 'tubo', 'ostruita', 'ostruito'].includes(word))
    && /tubazione.*\b(a24|a14)\b|\b(a24|a14)\b.*tubazione/i.test(content)) {
    score += 12;
  }

  for (const code of ['a24', 'a14', 'dr', 'ko']) {
    if (originalWords.includes(code) && new RegExp(`(^|[^a-z0-9])${code}([^a-z0-9]|$)`, 'i').test(content)) {
      score += 10;
    }
  }

  return score;
}

function escapePostgrestLikeValue(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

async function getTotalMessageCount() {
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from(SUPABASE_TABLE)
    .select('id', { count: 'exact', head: true });

  if (error) throw error;
  return count ?? 0;
}

async function fetchCandidateRows(usefulWords) {
  if (usefulWords.length === 0) return [];
  const supabase = getSupabaseClient();
  const filters = usefulWords
    .map((word) => `content.ilike.%${escapePostgrestLikeValue(word)}%`)
    .join(',');

  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .select('guild_id,guild_name,channel_id,channel_name,message_id,created_at,content,attachments,indexed_at')
    .or(filters)
    .order('created_at', { ascending: false })
    .limit(SUPABASE_SEARCH_LIMIT);

  if (error) throw error;
  return data ?? [];
}

function toSearchResult(row, score) {
  return {
    score,
    guildId: row.guild_id ?? null,
    guildName: row.guild_name ?? 'server sconosciuto',
    channelId: row.channel_id ?? null,
    channelName: row.channel_name ?? 'canale sconosciuto',
    messageId: row.message_id ?? null,
    createdAt: row.created_at ?? null,
    content: row.content ?? '',
    attachments: Array.isArray(row.attachments) ? row.attachments : []
  };
}

export async function searchArchive(query, options = {}) {
  const maxResults = options.maxResults ?? MAX_RESULTS;
  const searchQueries = buildArchiveSearchQueries(query);
  const originalWords = extractWords(query);
  const usefulWords = [...new Set(searchQueries.flatMap((searchQuery) => extractUsefulWords(searchQuery)))];

  if (usefulWords.length === 0) {
    return { archiveEmpty: false, results: [], usefulWords, searchQueries };
  }

  const candidatesByMessageId = new Map();

  // Prova tutte le query generate: una domanda naturale può non contenere il
  // codice salvato in archivio, ma i sinonimi tecnici possono portare al match.
  for (const searchQuery of searchQueries) {
    const queryWords = extractUsefulWords(searchQuery);
    const rows = await fetchCandidateRows(queryWords);

    for (const row of rows) {
      const key = row.message_id ?? `${row.channel_id}:${row.created_at}:${row.content}`;
      candidatesByMessageId.set(key, row);
    }
  }

  const candidates = [...candidatesByMessageId.values()];

  if (candidates.length === 0) {
    const totalMessages = await getTotalMessageCount();
    return { archiveEmpty: totalMessages === 0, results: [], usefulWords, searchQueries };
  }

  const matches = candidates
    .map((message) => toSearchResult(message, getMessageScore(message, usefulWords, originalWords, searchQueries)))
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    });

  return {
    archiveEmpty: false,
    results: matches.slice(0, maxResults),
    usefulWords,
    searchQueries
  };
}

export function formatArchiveResultsForDiscord(results) {
  return results.map((result) => {
    const attachments = result.attachments.length > 0
      ? `\nAllegati: ${result.attachments.map((attachment) => {
        const name = attachment.name ?? 'senza nome';
        const size = attachment.size ?? 'dimensione sconosciuta';
        const contentType = attachment.contentType ?? 'tipo sconosciuto';
        return `${name} (${contentType}, ${size} byte)`;
      }).join(', ')}`
      : '';

    return `Trovato in ${result.guildName} / #${result.channelName}${result.createdAt ? ` (${result.createdAt})` : ''}:\n${result.content}${attachments}`;
  }).join('\n\n---\n\n');
}

export function formatArchiveResultsForGemini(results) {
  return results.map((result, index) => {
    const attachments = result.attachments.length > 0
      ? `\nAllegati: ${JSON.stringify(result.attachments)}`
      : '';

    return `[Risultato ${index + 1}]\nServer: ${result.guildName}\nNome canale: #${result.channelName}\nID canale: ${result.channelId ?? 'non disponibile'}\nData messaggio: ${result.createdAt ?? 'non disponibile'}\nContenuto completo del messaggio:\n${result.content}${attachments}`;
  }).join('\n\n');
}
