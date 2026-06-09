import { searchWeb } from './webSearch.js';

export async function searchWeather(query, options = {}) {
  return searchWeb(`meteo ${query}`, options);
}
