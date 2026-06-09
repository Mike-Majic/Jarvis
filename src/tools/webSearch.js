const DEFAULT_PROVIDER = 'brave';
const DEFAULT_MAX_RESULTS = 5;
const WEB_SEARCH_TIMEOUT_MS = 8_000;

export class WebSearchConfigError extends Error {
  constructor(provider) {
    super(`Ricerca online non configurata per provider: ${provider}`);
    this.name = 'WebSearchConfigError';
    this.provider = provider;
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

function getProvider() {
  return normalizeText(process.env.WEB_SEARCH_PROVIDER || DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
}

function getProviderApiKey(provider) {
  if (provider === 'tavily') return process.env.TAVILY_API_KEY;
  return process.env.BRAVE_SEARCH_API_KEY;
}

function assertConfigured(provider) {
  if (!getProviderApiKey(provider)) {
    throw new WebSearchConfigError(provider);
  }
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${bodyText.slice(0, 500)}`);
    }

    return bodyText ? JSON.parse(bodyText) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function toSearchResult(result) {
  return {
    title: result.title ?? 'Risultato senza titolo',
    url: result.url ?? null,
    snippet: result.description ?? result.content ?? result.snippet ?? '',
    publishedAt: result.age ?? result.published_date ?? result.publishedAt ?? null
  };
}

async function searchWithBrave(query, maxResults) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  url.searchParams.set('country', 'IT');
  url.searchParams.set('search_lang', 'it');
  url.searchParams.set('safesearch', 'moderate');

  const data = await fetchJsonWithTimeout(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    }
  });

  const webResults = data.web?.results ?? [];
  const newsResults = data.news?.results ?? [];

  return [...webResults, ...newsResults].slice(0, maxResults).map(toSearchResult);
}

async function searchWithTavily(query, maxResults) {
  const apiKey = process.env.TAVILY_API_KEY;
  const data = await fetchJsonWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: true,
      include_raw_content: false
    })
  });

  const answerResult = data.answer
    ? [{ title: 'Risposta Tavily', url: null, content: data.answer }]
    : [];
  const results = data.results ?? [];

  return [...answerResult, ...results].slice(0, maxResults).map(toSearchResult);
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
  const provider = getProvider();
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

  logInfo('webSearch', `query=${query}`);
  logInfo('webSearch', `provider=${provider}`);

  try {
    assertConfigured(provider);

    if (provider === 'tavily') {
      return {
        provider,
        query,
        results: await searchWithTavily(query, maxResults)
      };
    }

    if (provider !== 'brave') {
      throw new Error(`Provider ricerca online non supportato: ${provider}`);
    }

    return {
      provider,
      query,
      results: await searchWithBrave(query, maxResults)
    };
  } catch (error) {
    logError('webSearch:error', error?.stack ?? error);
    throw error;
  }
}

export function formatWebResultsForGemini(search) {
  if (!search?.results?.length) return '';

  return search.results.map((result, index) => {
    const source = result.url ? `\nLink: ${result.url}` : '';
    const publishedAt = result.publishedAt ? `\nData/età risultato: ${result.publishedAt}` : '';
    return `[Fonte ${index + 1}]\nTitolo: ${result.title}${source}${publishedAt}\nEstratto:\n${result.snippet || 'Estratto non disponibile'}`;
  }).join('\n\n');
}
