# Jarvis

Jarvis è un bot Discord scritto in Node.js che funziona come una chat AI dentro un canale Discord.

Non usa comandi slash: gli utenti possono scrivere normalmente nel canale, ad esempio:

- `Jarvis cerca il numero 347...`
- `Jarvis che procedura devo seguire per guasto FTTH?`
- `Jarvis riassumi questa procedura`
- Oppure possono menzionare direttamente il bot: `@Jarvis aiutami con questa richiesta`

## Funzionalità attuali

- Legge i messaggi normali nei canali Discord.
- Risponde solo se viene menzionato oppure se il messaggio contiene la parola `Jarvis`.
- Ignora i messaggi inviati da altri bot.
- Usa Gemini API per generare risposte.
- Risponde sempre in italiano.
- Mantiene una piccola memoria conversazionale per canale, salvata solo in RAM.
- Indicizza messaggi e metadati degli allegati su Supabase nella tabella `discord_messages`.
- Cerca nello storico Supabase per usare i risultati come contesto nelle domande tecniche.
- Cerca online dati aggiornati con Tavily Search API quando la domanda lo richiede.
- Divide automaticamente le risposte troppo lunghe in più messaggi compatibili con Discord.
- Gestisce gli errori senza far crashare il processo.

## Cosa non fa ancora

Questa è una base funzionante. Per ora Jarvis **non**:

- scarica o legge allegati come PDF, Excel, Word o immagini;
- usa comandi slash.

## Requisiti

Jarvis usa il pacchetto ufficiale `@google/genai` per comunicare con Gemini API e `@supabase/supabase-js` per salvare/cercare lo storico Discord su Supabase.

- Node.js 18 o superiore.
- Un bot Discord creato nel [Discord Developer Portal](https://discord.com/developers/applications).
- Una chiave API Gemini.
- Una chiave Tavily API per la ricerca online aggiornata.
- Un progetto Supabase con la tabella `discord_messages` già creata.

## Installazione

### 1. Installa le dipendenze

```bash
npm install
```

### 2. Crea il file `.env`

Copia il file di esempio:

```bash
cp .env.example .env
```

Poi apri `.env` e inserisci i valori reali:

```env
DISCORD_TOKEN=il_token_del_tuo_bot_discord
GEMINI_API_KEY=la_tua_chiave_gemini
GEMINI_MODEL=gemini-2.5-flash
SUPABASE_URL=https://il-tuo-progetto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=la_tua_service_role_key
TAVILY_API_KEY=la_tua_chiave_tavily
INDEX_MAX_MESSAGES=5000
```

> Non committare mai il file `.env`: contiene segreti ed è già escluso da Git.

### 3. Abilita gli intenti Discord necessari

Nel Discord Developer Portal:

1. Apri la tua applicazione.
2. Vai su **Bot**.
3. Abilita **Message Content Intent**.
4. Salva le modifiche.

Senza questo intento, il bot non può leggere il contenuto dei messaggi normali del canale.

### 4. Invita il bot nel server

Nel Discord Developer Portal:

1. Vai su **OAuth2** → **URL Generator**.
2. Seleziona lo scope `bot`.
3. Seleziona permessi come:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
4. Apri l'URL generato e invita il bot nel server.

## Avvio

Avvia Jarvis con:

```bash
npm start
```

Se tutto è configurato correttamente, vedrai un messaggio simile:

```text
Jarvis è online come Jarvis#1234
```

## Uso in Discord

Scrivi in un canale in cui il bot ha accesso:

```text
Jarvis spiegami questa procedura in modo semplice
```

Oppure menziona il bot:

```text
@Jarvis cosa devo fare in caso di guasto FTTH?
```

Jarvis risponderà nel canale usando Gemini API.


## Ricerca online aggiornata

Jarvis può usare una ricerca web generica prima di chiamare Gemini quando la domanda richiede dati aggiornati, ad esempio:

- meteo e previsioni;
- notizie o eventi recenti;
- prezzi, quotazioni, cambi o crypto;
- aziende, prodotti, disponibilità e recensioni recenti;
- luoghi, indirizzi, orari o eventi;
- risultati sportivi, classifiche o calendari.

Provider supportato:

```env
TAVILY_API_KEY=la_tua_chiave_tavily
```

Se una domanda richiede dati aggiornati ma la chiave non è configurata, Jarvis risponde:

```text
La ricerca online non è ancora configurata. Serve impostare la chiave API su Render.
```

Quando la ricerca è configurata, Jarvis passa a Gemini un blocco `CONTENUTO WEB AGGIORNATO` con risultati, estratti e link. La risposta deve restare breve, includere la fonte principale quando disponibile e avvisare se i risultati non sono sufficienti. Se Tavily fallisce, Jarvis risponde con un messaggio chiaro invece del generico errore Discord. Nei log vedrai righe come `[webSearch] query=...`, `[webSearch] provider=...` e `[webSearch:error] ...`.

## Struttura del progetto

```text
.
├── .env.example     # Esempio delle variabili d'ambiente richieste
├── .gitignore       # File e cartelle da non committare
├── index.js              # File principale del bot
├── package.json          # Configurazione Node.js e script npm
├── src/
│   ├── archiveSearch.js  # Ricerca nello storico Supabase
│   ├── discordIndexer.js # Indicizzazione Discord su Supabase
│   ├── supabaseClient.js # Client Supabase lato server
│   └── tools/
│       ├── webSearch.js  # Ricerca online Tavily
│       └── weather.js    # Helper meteo basato sulla ricerca web
└── README.md             # Istruzioni del progetto
```

## Note sulla memoria conversazionale

La memoria è volutamente semplice:

- è separata per ogni canale Discord;
- conserva solo gli ultimi messaggi della conversazione;
- vive in RAM;
- viene cancellata quando il bot viene riavviato.

In futuro potrà essere sostituita o estesa con un database.



## Diagnostica Discord

Jarvis registra log con data e ora ISO per aiutare a capire eventuali disconnessioni su Render Free.

Vengono tracciati:

- avvio del client Discord;
- errori e avvisi del client;
- disconnessioni, riconnessioni, resume ed errori degli shard;
- heartbeat ogni 60 secondi con `client.ws.status`, ping e user tag disponibile.


## Errori Gemini e quota

Se nei log Render compaiono errori Gemini come:

- `503 UNAVAILABLE` o messaggi tipo `high demand`;
- `429 RESOURCE_EXHAUSTED`;
- `Quota exceeded`;

significa che il bot Discord è online, ma Google Gemini non sta accettando la richiesta in quel momento. Jarvis fa un breve retry automatico in caso di sovraccarico e, se Gemini continua a non rispondere, usa risposte locali per messaggi semplici o consiglia `Jarvis archivio <testo>` per interrogare direttamente Supabase.

Per risolvere controlla su Render e Google AI:

- `GEMINI_API_KEY` corretta;
- `GEMINI_MODEL` disponibile per la tua chiave;
- quota/rate limit del progetto Google AI;
- eventuale piano o billing se il limite free tier è stato raggiunto.

## Health check per Render

Per funzionare come **Render Web Service**, Jarvis avvia anche un piccolo server HTTP interno usando solo moduli Node.js nativi.

Endpoint disponibili:

- `GET /` risponde `Jarvis is running`;
- `GET /healthz` risponde `ok`;
- gli altri percorsi rispondono `404`.

La porta viene letta da `PORT`, impostata automaticamente da Render, con fallback locale a `3000`.

## Indicizzazione dei canali su Supabase

Jarvis indicizza lo storico del canale corrente su Supabase, nella tabella `discord_messages`. Render Free non offre storage persistente affidabile, quindi la cartella `data/` non viene più usata come archivio principale.

### Comandi temporanei per amministratori

I comandi di archivio funzionano solo se l'utente ha permessi amministratore.

Per indicizzare il canale corrente scrivi:

```text
Jarvis indicizza questo canale
```

Jarvis recupererà i messaggi storici del canale a blocchi da 100 messaggi tramite l'API Discord e salverà ogni messaggio come riga in Supabase. Usa `upsert` su `message_id`, così rilanciare l'indicizzazione dello stesso messaggio non crea duplicati. Al termine risponderà indicando:

- quanti messaggi sono stati salvati;
- quanti allegati sono stati trovati;
- che i dati sono stati salvati su Supabase.

Per controllare cosa è già stato salvato nell'archivio Supabase scrivi:

```text
Jarvis stato archivio
```

Jarvis risponderà con numero totale di canali indicizzati, totale messaggi, totale allegati e, per ogni canale, server, nome canale, `channel_id`, messaggi salvati, allegati trovati e data dell'ultima indicizzazione.

Per cercare direttamente su Supabase senza Gemini scrivi:

```text
Jarvis cerca archivio <testo>
```

Puoi usare anche l'alias:

```text
Jarvis verifica archivio <testo>
```

Esempio:

```text
Jarvis cerca archivio viola
```

Per cancellare solo le righe Supabase del canale corrente scrivi:

```text
Jarvis cancella archivio questo canale
```

Il comando elimina solo le righe della tabella `discord_messages` con `channel_id` uguale al canale corrente. Non cancella altri canali e non chiede conferma.

Per cancellare e ricreare l'archivio del canale corrente scrivi:

```text
Jarvis reindicizza questo canale
```

Jarvis cancella da Supabase solo le righe del canale corrente, poi rilancia l'indicizzazione e risponde con righe cancellate, messaggi salvati e allegati trovati.


### Procedura operativa consigliata - fase A

Per preparare lo storico prima di costruire la ricerca:

1. Entra nel canale dedicato alle procedure.
2. Scrivi `Jarvis indicizza questo canale`.
3. Attendi il messaggio di completamento con numero messaggi e allegati salvati su Supabase.
4. Ripeti la stessa operazione nei canali importanti, ad esempio storico, interventi e numeri.
5. Scrivi `Jarvis stato archivio` per controllare quali canali sono stati salvati e quando sono stati indicizzati.
6. Prova una ricerca diretta, ad esempio `Jarvis cerca archivio viola`.
7. Se vuoi rifare un canale, entra in quel canale e scrivi `Jarvis reindicizza questo canale`.


## Ricerca nell'archivio Supabase

Dopo aver indicizzato uno o più canali, Jarvis può usare le righe Supabase della tabella `discord_messages` come contesto, ma solo quando la domanda sembra davvero legata a dati operativi, procedure, storico, numerazioni o ricerca tecnica.

Esempio:

```text
Jarvis il colore viola della fibra, che numero è?
```

Per le domande tecniche o operative Jarvis analizza la frase, genera più query di ricerca e cerca sempre prima su Supabase nella colonna `content` prima di chiamare Gemini o la ricerca online. Questo vale per procedure, guasti, lavorazioni, causali, chiusura ticket e attività tecniche come `tubazione ostruita`, `come lo chiudo`, `delivery`, `assurance`, `permuta`, `KO`, `Remedy` o `Flower`. Se trova messaggi pertinenti, aggiunge un blocco `CONTENUTO ARCHIVIO DISCORD` alla richiesta inviata a Gemini e non usa Tavily per sostituire quei dati. Quando questo blocco è presente, Jarvis deve dare priorità assoluta ai dati dell'archivio: se il contesto contiene la risposta, risponde usando quei dati; solo se l'archivio non trova risultati può passare alla ricerca online.

Per i messaggi normali, ad esempio `Jarvis fa caldo`, `Jarvis come stai`, `Jarvis annamo bene` o battute/sfottò, Jarvis non cerca nell'archivio e risponde in modo naturale con Gemini o con risposte personalizzate.

Puoi anche interrogare direttamente l'archivio senza usare Gemini:

```text
Jarvis cerca archivio viola
```

Forma breve equivalente:

```text
Jarvis archivio viola
```

Esempio tecnico:

```text
Jarvis cerca archivio tubazione ostruita
```

Questa ricerca può trovare anche un messaggio che contiene `TUBAZIONE A24 | A14`, grazie ai sinonimi tecnici.

oppure:

```text
Jarvis verifica archivio viola
```

Questo comando restituisce i risultati trovati su Supabase, includendo server, canale, data, contenuto utile del messaggio e metadati degli allegati se presenti. Se il messaggio archiviato contiene più procedure nello stesso blocco, Jarvis prova a mostrare solo la sezione più collegata alla domanda.

La ricerca è keyword based, case-insensitive e supporta anche codici brevi o alfanumerici come `A24`, `A14`, `DR` e `KO`. Usa anche una mappa di sinonimi tecnici: ad esempio `tubazione ostruita` prova anche `tubazione`, `ostruita`, `chiusura tubazione`, `A24` e `A14`; `fibra` espande verso colori, numerazione, splitter e cavo; `causale` espande verso chiusura, `A24`, `A14`, `DR` e `KO`; `riparato in RL` espande verso `COD R`, `RISCONTRATO PROVATO CLT SI`, riparazione in armadio e permuta. La stessa logica multi-query viene usata sia dalle domande automatiche sia da `Jarvis cerca archivio <testo>`. Dopo la ricerca, Jarvis estrae la sezione più rilevante del messaggio archiviato: per esempio, se un blocco contiene più procedure `COD`, una domanda su `chiusura riparato in RL` deve preferire `COD: R` e la sottosezione `IN ARMADIO`, senza riportare gli altri codici.


Per chiedere esplicitamente il testo completo di un blocco archiviato puoi aggiungere frasi come:

```text
Jarvis cerca archivio riparato in RL mandami tutto
Jarvis cerca archivio COD R fammi vedere tutta la procedura
```

Senza queste frasi Jarvis evita di incollare tutto il blocco grezzo e mantiene la risposta più breve e pronta da usare.

Se Supabase non contiene ancora righe indicizzate, Jarvis risponde:

```text
Archivio vuoto. Prima indicizza almeno un canale.
```

Se la ricerca non trova risultati, Jarvis risponde:

```text
Non ho trovato risultati nell'archivio.
```

### Dati salvati

Per ogni messaggio Jarvis salva una riga nella tabella Supabase `discord_messages` con testo e metadati:

- `guild_id`
- `guild_name`
- `channel_id`
- `channel_name`
- `message_id`
- `author_id`
- `author_tag`
- `created_at`
- `content`
- `attachments`, come array JSON con ID, nome file, URL, content type e dimensione;
- `indexed_at`.

Ogni canale resta separato tramite `channel_id` e ogni server tramite `guild_id`.

### Limite massimo di sicurezza

Per evitare scansioni troppo grandi o loop indesiderati, Jarvis usa un limite massimo di messaggi indicizzabili per singolo comando.

Nel file `.env` puoi configurarlo così:

```env
INDEX_MAX_MESSAGES=5000
```

Se la variabile non è presente o non è valida, Jarvis usa `5000` come valore predefinito.

### Limiti attuali dell'indicizzazione

Per ora Jarvis:

- non scarica gli allegati;
- non legge PDF, Excel o Word;
- non usa più `data/` come archivio principale;
- invia a Gemini solo piccoli estratti testuali recuperati da Supabase quando una domanda tecnica trova risultati pertinenti;
- salva lo storico indicizzato su Supabase nella tabella `discord_messages`.

La scansione usa pause tra i blocchi e tentativi automatici in caso di errori temporanei o rate limit.
