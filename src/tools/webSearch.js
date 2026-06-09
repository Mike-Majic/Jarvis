import { tavily } from '@tavily/core';

const DEFAULT_MAX_RESULTS = 5;
const WEB_SEARCH_TIMEOUT_MS = 8_000;

export class WebSearchConfigError extends Error {
  constructor() {
    super('Ricerca online non configurata');
    this.name = 'WebSearchConfigError';
  }
}

function formatLogPrefix(scope) {
  return `[${new Date().toISOString()}] [${scope}]`;
}

function logInfo(scope, message, ...details) {
  console.log(`${formatLogPrefix(scope)} ${message}`, ...details);
}

function logError(scope, message, ...details) {
  console.error(`${formatLogPrefix(scope)} ${message}`, ...details);
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getTavilyApiKey() {
  return process.env.TAVILY_API_KEY;
}

function assertConfigured() {
  if (!getTavilyApiKey()) {
    throw new WebSearchConfigError();
  }
}

function withTimeout(promise, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timeout ricerca online dopo ${timeoutMs} ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function toSearchResult(result) {
  return {
    title: result.title ?? 'Risultato senza titolo',
    url: result.url ?? null,
    snippet: result.content ?? result.rawContent ?? result.description ?? '',
    score: result.score ?? null,
    publishedAt: result.publishedDate ?? result.published_date ?? result.publishedAt ?? null
  };
}

function buildSyntheticAnswer(answer, results) {
  if (answer) return answer;

  if (results.length === 0) {
    return 'Non ho trovato risultati online sufficienti.';
  }

  const firstResult = results[0];
  const source = firstResult.url ? ` Fonte: ${firstResult.url}` : '';
  return `${firstResult.snippet || firstResult.title}${source}`.trim();
}

export function shouldUseWebSearch(prompt) {
  const normalized = normalizeText(prompt);
  const realtimePatterns = [
    /\b(oggi|domani|ieri|adesso|ora|attuale|attuali|aggiornato|aggiornati|ultim[aoie]|recente|recenti)\b/,
    /\b(news|notizie|novita|breaking|cronaca)\b/,
    /\b(prezzo|prezzi|costo|costa|quotazione|borsa|azioni|crypto|bitcoin|ethereum|cambio|euro|dollaro)\b/,
    /\b(meteo|tempo|previsioni|temperatura|piove|piovera|neve|vento)\b/,
    /\b(azienda|societa|ceo|fondatore|presidente|governo|sindaco|fatturato|bilancio|prodotto|prodotti|recensione|recensioni|disponibile|uscita)\b/,
    /\b(evento|eventi|concerto|concerti|fiera|sagra|luogo|ristorante|hotel|negozio|aperto|chiuso|orari|orario|indirizzo)\b/,
    /\b(partita|risultato|risultati|classifica|calendario|serie a|champions|nba|motogp|formula 1|f1)\b/,
    /\b(volo|voli|treno|treni|traffico|sciopero|allerta|terremoto)\b/,
    /\b(cerca online|cerca su internet|guarda online|verifica online|controlla online)\b/
  ];

  return realtimePatterns.some((pattern) => pattern.test(normalized));
}

export async function searchWeb(query, options = {}) {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  logInfo('webSearch', `query=${query}`);
  logInfo('webSearch', 'provider=tavily');

  try {
    assertConfigured();

    const client = tavily({ apiKey: getTavilyApiKey() });
    const response = await withTimeout(
      client.search(query, {
        searchDepth: 'basic',
        maxResults,
        includeAnswer: true,
        includeRawContent: false
      }),
      WEB_SEARCH_TIMEOUT_MS
    );

    const results = (response.results ?? []).slice(0, maxResults).map(toSearchResult);

    return {
      provider: 'tavily',
      query,
      answer: response.answer ?? null,
      responseText: buildSyntheticAnswer(response.answer, results),
      results,
      sources: results.map((result) => ({ title: result.title, url: result.url })).filter((source) => source.url)
    };
  } catch (error) {
    logError('webSearch:error', error?.stack ?? error);
    throw error;
  }
}

export function formatWebResultsForGemini(search) {
  if (!search) return '';

  const answer = search.responseText ? `Risposta sintetica Tavily:\n${search.responseText}\n\n` : '';
  const sources = search.results?.length
    ? search.results.map((result, index) => {
      const source = result.url ? `\nLink: ${result.url}` : '';
      const publishedAt = result.publishedAt ? `\nData risultato: ${result.publishedAt}` : '';
      return `[Fonte ${index + 1}]\nTitolo: ${result.title}${source}${publishedAt}\nEstratto:\n${result.snippet || 'Estratto non disponibile'}`;
    }).join('\n\n')
    : 'Nessuna fonte disponibile.';

  return `${answer}${sources}`;
}
