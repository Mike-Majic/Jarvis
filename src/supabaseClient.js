import { createClient } from '@supabase/supabase-js';

export class SupabaseConfigError extends Error {
  constructor() {
    super('SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurati.');
    this.name = 'SupabaseConfigError';
  }
}

let supabaseClient;

export function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new SupabaseConfigError();
  }

  // Il bot gira lato server su Render: usiamo la service role key solo come variabile
  // ambiente privata e disabilitiamo la persistenza di sessione, non necessaria qui.
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return supabaseClient;
}
