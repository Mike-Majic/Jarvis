import { getSupabaseClient } from './supabaseClient.js';

const SUPABASE_TABLE = 'guild_settings';
const CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_SETTINGS = Object.freeze({
  restrictRoleId: null,
  enableWorkMemory: true
});

const settingsCache = new Map();

function toSettings(row) {
  if (!row) return DEFAULT_SETTINGS;

  return {
    restrictRoleId: row.restrict_role_id ?? null,
    enableWorkMemory: row.enable_work_memory !== false
  };
}

// Il flag di accesso e la memoria di lavoro sono per-guild: cache in RAM con
// TTL breve per non interrogare Supabase a ogni messaggio, ma restare
// aggiornati abbastanza in fretta se le impostazioni cambiano.
export async function getGuildSettings(guildId) {
  if (!guildId) return DEFAULT_SETTINGS;

  const cached = settingsCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.settings;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(SUPABASE_TABLE)
    .select('guild_id,restrict_role_id,enable_work_memory')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) throw error;

  const settings = toSettings(data);
  settingsCache.set(guildId, { settings, expiresAt: Date.now() + CACHE_TTL_MS });
  return settings;
}
