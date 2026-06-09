import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const MAX_RESULTS = 5;
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
  'numero',
  'colore',
  'della',
  'del',
  'di',
  'a',
  'e',
  'o'
]);

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractUsefulWords(query) {
  const normalized = normalizeText(query);
  const words = normalized.match(/[a-z0-9]+/g) ?? [];

  return [...new Set(words.filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
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

function getMessageScore(message, usefulWords) {
  const content = normalizeText(message.content);
  return usefulWords.filter((word) => content.includes(word)).length;
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
      const score = getMessageScore(message, usefulWords);

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

    return `[Risultato ${index + 1}] Canale: #${result.channelName}\nData: ${result.createdAt ?? 'non disponibile'}\nContenuto:\n${result.content}${attachments}`;
  }).join('\n\n');
}
