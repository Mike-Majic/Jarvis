import { getSupabaseClient } from './supabaseClient.js';

const SUPABASE_TABLE = 'discord_messages';
const MAX_RESULTS = 10;
const SUPABASE_SEARCH_LIMIT = 200;
const STOP_WORDS = new Set([
  'jarvis',
  'il',
  'lo',
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
  if (!hasArchiveDomainWord(words)) return words;

  // Se la domanda riguarda colori/fibra/numerazioni, cerchiamo anche i termini
  // tipici delle tabelle colori: spesso il messaggio indicizzato contiene solo
  // la lista completa e non tutte le parole della domanda dell'utente.
  return [...words, 'colori', 'colore', 'fibra', 'numerazione', 'numero', ...COLOR_WORDS];
}

function extractUsefulWords(query) {
  const words = extractWords(query);
  const usefulWords = words.filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  return [...new Set(expandDomainWords(usefulWords))];
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

function getMessageScore(message, usefulWords, originalWords) {
  const content = normalizeText(message.content);
  const matchedWords = usefulWords.filter((word) => content.includes(word));
  let score = matchedWords.length;

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
  const originalWords = extractWords(query);
  const usefulWords = extractUsefulWords(query);

  if (usefulWords.length === 0) {
    return { archiveEmpty: false, results: [], usefulWords };
  }

  const candidates = await fetchCandidateRows(usefulWords);

  if (candidates.length === 0) {
    const totalMessages = await getTotalMessageCount();
    return { archiveEmpty: totalMessages === 0, results: [], usefulWords };
  }

  const matches = candidates
    .map((message) => toSearchResult(message, getMessageScore(message, usefulWords, originalWords)))
    .filter((result) => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    });

  return {
    archiveEmpty: false,
    results: matches.slice(0, maxResults),
    usefulWords
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
