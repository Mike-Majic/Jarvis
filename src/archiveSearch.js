import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const MAX_RESULTS = 10;
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

async function readArchiveFiles() {
  try {
    const fileNames = await readdir(DATA_DIR);
    return fileNames
      .filter((fileName) => /^channel_\d+\.json$/.test(fileName))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
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

function toSearchResult(message, archiveData, score) {
  return {
    score,
    channelName: message.channelName ?? archiveData.channelName ?? 'canale sconosciuto',
    createdAt: message.createdAt ?? null,
    content: message.content ?? '',
    attachments: Array.isArray(message.attachments) ? message.attachments : []
  };
}

export async function searchArchive(query, options = {}) {
  const maxResults = options.maxResults ?? MAX_RESULTS;
  const originalWords = extractWords(query);
  const usefulWords = extractUsefulWords(query);

  if (usefulWords.length === 0) {
    return { archiveEmpty: false, results: [], usefulWords };
  }

  const fileNames = await readArchiveFiles();

  if (fileNames.length === 0) {
    return { archiveEmpty: true, results: [], usefulWords };
  }

  const matches = [];

  for (const fileName of fileNames) {
    const filePath = path.join(DATA_DIR, fileName);
    const rawContent = await readFile(filePath, 'utf8');
    const archiveData = JSON.parse(rawContent);
    const messages = Array.isArray(archiveData.messages) ? archiveData.messages : [];

    for (const message of messages) {
      const score = getMessageScore(message, usefulWords, originalWords);

      if (score > 0) {
        matches.push(toSearchResult(message, archiveData, score));
      }
    }
  }

  matches.sort((a, b) => {
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

    return `Trovato in #${result.channelName}${result.createdAt ? ` (${result.createdAt})` : ''}:\n${result.content}${attachments}`;
  }).join('\n\n---\n\n');
}

export function formatArchiveResultsForGemini(results) {
  return results.map((result, index) => {
    const attachments = result.attachments.length > 0
      ? `\nAllegati: ${JSON.stringify(result.attachments)}`
      : '';

    return `[Risultato ${index + 1}]\nNome canale: #${result.channelName}\nData messaggio: ${result.createdAt ?? 'non disponibile'}\nContenuto completo del messaggio:\n${result.content}${attachments}`;
  }).join('\n\n');
}
