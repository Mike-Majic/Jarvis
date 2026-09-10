-- Tabella di configurazione per-guild di Jarvis.
-- Vedi README.md, sezione "Configurazione per-guild (guild_settings)".

create table if not exists guild_settings (
  guild_id text primary key,
  restrict_role_id text,
  enable_work_memory boolean not null default true
);

-- GTA VI Community Italia: solo il ruolo Moderatore può usare Jarvis su questa
-- guild e la memoria di lavoro (codici di chiusura, dati interni) resta disattivata.
-- Sostituisci <MODERATORE_ROLE_ID> con l'ID reale del ruolo prima di eseguire.
insert into guild_settings (guild_id, restrict_role_id, enable_work_memory)
values ('1544011913564786809', '<MODERATORE_ROLE_ID>', false)
on conflict (guild_id) do update
set restrict_role_id = excluded.restrict_role_id,
    enable_work_memory = excluded.enable_work_memory;
