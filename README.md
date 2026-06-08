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
- Divide automaticamente le risposte troppo lunghe in più messaggi compatibili con Discord.
- Gestisce gli errori senza far crashare il processo.

## Cosa non fa ancora

Questa è una base funzionante. Per ora Jarvis **non**:

- indicizza due anni di messaggi Discord;
- usa un database;
- si collega a Supabase;
- usa comandi slash.

## Requisiti

Jarvis usa il pacchetto ufficiale `@google/genai` per comunicare con Gemini API.


- Node.js 18 o superiore.
- Un bot Discord creato nel [Discord Developer Portal](https://discord.com/developers/applications).
- Una chiave API Gemini.

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

## Struttura del progetto

```text
.
├── .env.example     # Esempio delle variabili d'ambiente richieste
├── .gitignore       # File e cartelle da non committare
├── index.js         # File principale del bot
├── package.json     # Configurazione Node.js e script npm
└── README.md        # Istruzioni del progetto
```

## Note sulla memoria conversazionale

La memoria è volutamente semplice:

- è separata per ogni canale Discord;
- conserva solo gli ultimi messaggi della conversazione;
- vive in RAM;
- viene cancellata quando il bot viene riavviato.

In futuro potrà essere sostituita o estesa con un database.


## Health check per Render

Per funzionare come **Render Web Service**, Jarvis avvia anche un piccolo server HTTP interno usando solo moduli Node.js nativi.

Endpoint disponibili:

- `GET /` risponde `Jarvis is running`;
- `GET /healthz` risponde `ok`;
- gli altri percorsi rispondono `404`.

La porta viene letta da `PORT`, impostata automaticamente da Render, con fallback locale a `3000`.

## Indicizzazione locale dei canali

Jarvis include una prima struttura per indicizzare lo storico del canale corrente in un archivio locale. Questa funzione serve a preparare una base dati JSON che in futuro potrà essere usata per ricerca, riassunti o ulteriori elaborazioni.

### Comandi temporanei per amministratori

I comandi di archivio funzionano solo se l'utente ha permessi amministratore.

Per indicizzare il canale corrente scrivi:

```text
Jarvis indicizza questo canale
```

Jarvis recupererà i messaggi storici del canale a blocchi da 100 messaggi tramite l'API Discord e salverà un file JSON nella cartella `data/`. Al termine risponderà indicando:

- quanti messaggi sono stati salvati;
- quanti allegati sono stati trovati;
- il percorso del file JSON creato.

Per controllare cosa è già stato salvato nell'archivio locale scrivi:

```text
Jarvis stato archivio
```

Jarvis risponderà con il numero di file `channel_*.json` presenti e, per ogni canale indicizzato, mostrerà nome canale, messaggi salvati, allegati trovati e data dell'ultima indicizzazione.

Per cancellare solo l'archivio JSON del canale corrente scrivi:

```text
Jarvis cancella archivio questo canale
```

Il comando elimina solo `data/channel_<channelId>.json` del canale corrente. Non chiede conferma e risponde se il file è stato cancellato, se non era presente o se si è verificato un errore.

Per cancellare e ricreare l'archivio del canale corrente scrivi:

```text
Jarvis reindicizza questo canale
```

Jarvis rimuove il vecchio JSON del canale corrente, se esiste, poi rilancia l'indicizzazione e risponde con messaggi salvati, allegati trovati e percorso del file creato.


### Procedura operativa consigliata - fase A

Per preparare lo storico prima di costruire la ricerca:

1. Entra nel canale dedicato alle procedure.
2. Scrivi `Jarvis indicizza questo canale`.
3. Attendi il messaggio di completamento con numero messaggi, allegati e percorso file.
4. Ripeti la stessa operazione nei canali importanti, ad esempio storico, interventi e numeri.
5. Scrivi `Jarvis stato archivio` per controllare quali canali sono stati salvati e quando sono stati indicizzati.
6. Se vuoi rifare un canale, entra in quel canale e scrivi `Jarvis reindicizza questo canale`.

### Dati salvati

Per ogni canale viene creato un file:

```text
data/channel_<channelId>.json
```

Per ogni messaggio vengono salvati solo testo e metadati:

- `messageId`
- `channelId`
- `channelName`
- `guildId`
- `authorId`
- `authorTag`
- `createdAt`
- `content`
- `attachments`, con:
  - ID;
  - nome file;
  - URL;
  - content type;
  - dimensione.

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
- non usa database;
- non invia i dati indicizzati a Gemini;
- salva solo un archivio JSON locale per canale.

La scansione usa pause tra i blocchi e tentativi automatici in caso di errori temporanei o rate limit.
