-- Tabella di configurazione per-guild di Jarvis.
-- Vedi README.md, sezione "Configurazione per-guild (guild_settings)".

create table if not exists guild_settings (
  guild_id text primary key,
  restrict_role_id text,
  enable_work_memory boolean not null default true
);

-- Jarvis legge/scrive con la service role key (bypassa RLS); nessuna policy
-- pubblica: coerente con discord_messages, che ha già RLS abilitata.
alter table guild_settings enable row level security;

-- GTA VI Community Italia: solo il ruolo Moderatore può usare Jarvis su questa
-- guild e la memoria di lavoro (codici di chiusura, dati interni) resta disattivata.
insert into guild_settings (guild_id, restrict_role_id, enable_work_memory)
values ('1544011913564786809', '1544015623087071283', false)
on conflict (guild_id) do update
set restrict_role_id = excluded.restrict_role_id,
    enable_work_memory = excluded.enable_work_memory;
